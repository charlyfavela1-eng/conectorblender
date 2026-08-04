bl_info = {
    "name": "Seedance Connector",
    "author": "Seedance Studio",
    "version": (1, 0, 0),
    "blender": (3, 0, 0),
    "location": "Vista 3D > barra lateral (N) > Seedance",
    "description": "Puente con el backend: Blender jala ordenes y devuelve resultados.",
    "category": "System",
}

# Puente Codespace ↔ Blender, gemelo del panel CEP de After Effects.
#
# El backend NUNCA alcanza esta maquina, asi que es Blender el que jala:
# cada pocos segundos pregunta si hay trabajo, ejecuta el Python que venga y
# devuelve el resultado.
#
# Todo corre en el hilo principal via bpy.app.timers, porque bpy NO es seguro
# desde hilos: tocarlo desde un thread cuelga o revienta Blender sin aviso.
# El HTTP se hace con urllib de la libreria estandar — Blender no trae requests.

import json
import queue
import ssl
import threading
import traceback
import urllib.error
import urllib.parse
import urllib.request

import bpy

# Contexto SSL. El Python que trae Blender muchas veces NO incluye el bundle de
# certificados del sistema, y entonces cualquier https revienta con
# "urlopen error [SSL: CERTIFICATE_VERIFY_FAILED]". Se intenta con verificacion;
# si el sistema no tiene CAs, se cae a un contexto sin verificar. Es aceptable
# porque el destino es el backend propio y la clave viaja igual cifrada.
try:
    import certifi
    _SSL = ssl.create_default_context(cafile=certifi.where())
except Exception:
    _SSL = ssl.create_default_context()
_SSL_SIN_VERIFICAR = ssl._create_unverified_context()

# El trabajo que trajo el hilo de red, esperando a ejecutarse en el hilo principal
_pendientes = queue.Queue()
_corriendo = False
_ultimo_error = ""


def _prefs():
    p = bpy.context.scene.seedance
    return p.url.rstrip("/"), p.clave


def _http(ruta, datos=None, metodo="GET", timeout=20):
    """Peticion al backend. Devuelve dict, o None si algo falla."""
    url, clave = _prefs()
    if not url or not clave:
        return None
    destino = "%s%s?key=%s" % (url, ruta, urllib.parse.quote(clave))
    cuerpo = None
    cabeceras = {"Accept": "application/json"}
    if datos is not None:
        cuerpo = json.dumps(datos).encode("utf-8")
        cabeceras["Content-Type"] = "application/json"
    req = urllib.request.Request(destino, data=cuerpo, headers=cabeceras, method=metodo)
    global _ultimo_error
    for contexto in (_SSL, _SSL_SIN_VERIFICAR):
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=contexto) as r:
                _ultimo_error = ""
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # 401 = clave equivocada. Se dice claro en vez de "urlopen error".
            _ultimo_error = ("Clave incorrecta (401)" if e.code == 401
                             else "El servidor contesto HTTP %s" % e.code)
            return None
        except urllib.error.URLError as e:
            razon = str(getattr(e, "reason", e))
            if "CERTIFICATE" in razon.upper() or "SSL" in razon.upper():
                continue   # se reintenta sin verificar certificado
            _ultimo_error = "Sin conexion: %s" % razon[:70]
            return None
        except Exception as e:
            _ultimo_error = "%s: %s" % (type(e).__name__, str(e)[:60])
            return None
    _ultimo_error = "Fallo el certificado SSL incluso sin verificar"
    return None


def _ejecutar(job):
    """Corre el Python del job en el hilo principal y reporta el resultado.

    El script recibe responder(obj): lo que le pase es lo que vuelve. Si truena,
    se manda el traceback completo — el backend se lo da a Claude para que lo
    reescriba, asi que mientras mas exacto el error, mejor el arreglo.
    """
    salida = {"valor": None}

    def responder(obj):
        salida["valor"] = obj

    entorno = {
        "bpy": bpy,
        "responder": responder,
        "__name__": "__seedance__",
    }
    try:
        exec(compile(job["python"], "<seedance>", "exec"), entorno)
        _http("/api/blender/result", {"jobId": job["jobId"], "result": salida["valor"]}, "POST", timeout=60)
        return True
    except Exception:
        _http("/api/blender/result",
              {"jobId": job["jobId"], "error": traceback.format_exc()},
              "POST", timeout=60)
        return False


def _hilo_red():
    """Pregunta por trabajo y manda latido. Vive fuera del hilo principal."""
    r = _http("/api/blender/pending")
    if r and r.get("job"):
        _pendientes.put(r["job"])
    else:
        # Sin trabajo, el pending ya cuenta como latido; sólo se refresca el estado.
        _http("/api/blender/heartbeat", {"estado": bpy.data.filepath or "(sin guardar)"}, "POST", timeout=15)


def _tick():
    """Timer del hilo principal. Ejecuta lo que haya llegado y relanza la consulta.

    ⚠️ TODO va dentro de un try. Si esta funcion lanza una excepcion, Blender
    DESREGISTRA el timer en silencio y el addon se queda mudo sin decir nada —
    fue justo lo que paso: conectaba, mandaba un latido y se moria. El caso
    tipico es tocar bpy.context.scene cuando el contexto todavia no esta listo.
    """
    if not _corriendo:
        return None   # devolver None desregistra el timer, aqui si a proposito

    intervalo = 3.0
    global _ultimo_error
    try:
        # 1) Ejecutar lo que trajo la red (aqui SI se puede tocar bpy)
        while not _pendientes.empty():
            try:
                _ejecutar(_pendientes.get_nowait())
            except Exception:
                traceback.print_exc()

        # 2) Volver a preguntar, en un hilo para no congelar la interfaz
        threading.Thread(target=_hilo_red, daemon=True).start()

        try:
            pantalla = bpy.context.screen
            for area in (pantalla.areas if pantalla else []):
                if area.type == 'VIEW_3D':
                    area.tag_redraw()
        except Exception:
            pass

        try:
            intervalo = float(bpy.context.scene.seedance.intervalo)
        except Exception:
            pass   # el contexto aun no esta listo: se usa el default y se sigue
    except Exception as e:
        _ultimo_error = "Error interno: %s" % str(e)[:60]
        traceback.print_exc()

    return max(1.0, intervalo)   # NUNCA None por accidente: el timer sigue vivo


class SeedanceProps(bpy.types.PropertyGroup):
    url: bpy.props.StringProperty(
        name="Backend",
        description="URL publica del servidor (la del Codespace o Render)",
        default="https://",
    )
    clave: bpy.props.StringProperty(
        name="Clave",
        description="La misma CLAUDE_KEY del backend",
        default="",
        subtype='PASSWORD',
    )
    intervalo: bpy.props.FloatProperty(
        name="Cada",
        description="Segundos entre consultas",
        default=3.0, min=1.0, max=30.0,
    )


class SEEDANCE_OT_conectar(bpy.types.Operator):
    bl_idname = "seedance.conectar"
    bl_label = "Conectar"
    bl_description = "Empieza a jalar ordenes del backend"

    def execute(self, context):
        global _corriendo
        p = context.scene.seedance
        if not p.url.startswith("http") or not p.clave:
            self.report({'ERROR'}, "Pon la URL del backend y la clave")
            return {'CANCELLED'}
        if _corriendo:
            self.report({'INFO'}, "Ya estaba conectado")
            return {'FINISHED'}
        _corriendo = True
        bpy.app.timers.register(_tick, first_interval=0.5, persistent=True)
        self.report({'INFO'}, "Seedance conectado")
        return {'FINISHED'}


class SEEDANCE_OT_desconectar(bpy.types.Operator):
    bl_idname = "seedance.desconectar"
    bl_label = "Desconectar"

    def execute(self, context):
        global _corriendo
        _corriendo = False
        if bpy.app.timers.is_registered(_tick):
            bpy.app.timers.unregister(_tick)
        self.report({'INFO'}, "Seedance desconectado")
        return {'FINISHED'}


class SEEDANCE_PT_panel(bpy.types.Panel):
    bl_label = "Seedance"
    bl_idname = "SEEDANCE_PT_panel"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = "Seedance"

    def draw(self, context):
        col = self.layout.column()
        p = context.scene.seedance
        col.prop(p, "url")
        col.prop(p, "clave")
        col.prop(p, "intervalo")
        col.separator()
        if _corriendo:
            col.label(text="Conectado, esperando ordenes", icon='LINKED')
            col.operator("seedance.desconectar", icon='UNLINKED')
        else:
            col.label(text="Desconectado", icon='UNLINKED')
            col.operator("seedance.conectar", icon='PLAY')
        if _ultimo_error:
            col.separator()
            col.label(text="Problema:", icon='ERROR')
            # El error se parte en renglones: cortado a 38 caracteres solo se leia
            # "urlopen error" y no se podia diagnosticar nada.
            t = _ultimo_error
            while t:
                col.label(text=t[:34])
                t = t[34:]


CLASES = (SeedanceProps, SEEDANCE_OT_conectar, SEEDANCE_OT_desconectar, SEEDANCE_PT_panel)


def register():
    for c in CLASES:
        bpy.utils.register_class(c)
    bpy.types.Scene.seedance = bpy.props.PointerProperty(type=SeedanceProps)


def unregister():
    global _corriendo
    _corriendo = False
    if bpy.app.timers.is_registered(_tick):
        bpy.app.timers.unregister(_tick)
    del bpy.types.Scene.seedance
    for c in reversed(CLASES):
        bpy.utils.unregister_class(c)


# Se puede usar de DOS formas:
#
#   A) Como add-on:  Editar > Preferencias > Add-ons > Install, elegir este
#      archivo, y MARCAR LA CASILLA (instalarlo no lo activa).
#
#   B) Sin instalar nada, que es lo mas rapido y nunca falla:
#      arriba en Blender cambia a la pestaña "Scripting", abre este archivo
#      (Text > Open) y dale al boton de PLAY (Run Script). Listo, el panel
#      aparece de inmediato en la vista 3D con la tecla N.
if __name__ == "__main__":
    try:
        unregister()          # por si ya estaba cargado de antes
    except Exception:
        pass
    register()
    print("Seedance Connector cargado. Vista 3D > tecla N > pestaña Seedance")
