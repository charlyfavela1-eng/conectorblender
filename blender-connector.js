// blender-connector.js — Ejecuta Python dentro de Blender y se autocorrige.
//
// Mismo patrón que ae-connector.js, con dos diferencias grandes a favor:
//   · Blender corre Python 3 completo (bpy), no el ES3 mutilado de ExtendScript.
//   · Los jobs pueden tardar minutos (un render de Cycles), así que el timeout
//     es largo y el addon reporta progreso.
//
// El contrato con el addon: el script recibe una función `responder(obj)` ya
// inyectada. Lo que le pases es lo que vuelve como resultado del job. Si el
// script truena, el traceback vuelve como error y Claude intenta arreglarlo.

import Anthropic from '@anthropic-ai/sdk';
import { createJob, getJob } from './blender-queue.js';

const MODELO = process.env.ANTHROPIC_MODEL_LIGHT || 'claude-haiku-4-5-20251001';

// Un render puede tardar. 12 min de tope, muy por encima de los 30 s de AE.
const ESPERA_MAX_MS = 12 * 60 * 1000;
const INTERVALO_MS = 1000;

function esperaJob(jobId, maxMs = ESPERA_MAX_MS) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      const job = getJob(jobId);
      if (!job) { clearInterval(tick); return reject(new Error('job desaparecido')); }
      if (job.status === 'completed') { clearInterval(tick); return resolve(job); }
      if (job.status === 'failed') { clearInterval(tick); return resolve(job); }
      if (Date.now() - t0 > maxMs) {
        clearInterval(tick);
        reject(new Error(`Blender no contestó en ${Math.round(maxMs / 60000)} min. ¿Sigue abierto el addon?`));
      }
    }, INTERVALO_MS);
  });
}

/**
 * Manda Python a Blender. Si truena, se lo pasa a Claude para que lo reescriba
 * y reintenta. `intentos` cuenta el original, así que 3 = original + 2 arreglos.
 */
export async function ejecutarEnBlender(python, meta = {}, intentos = 3) {
  const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
  let codigo = python;
  let ultimoError = null;

  for (let i = 0; i < intentos; i++) {
    const job = createJob(codigo, { ...meta, intento: i + 1 });
    const hecho = await esperaJob(job.jobId);

    if (hecho.status === 'completed') {
      return { ok: true, resultado: hecho.result, intentos: i + 1, python: codigo };
    }

    ultimoError = hecho.error;
    if (i === intentos - 1 || !anthropic) break;

    // Reescritura: se le da el error real de Blender, no una descripción.
    try {
      const r = await anthropic.messages.create({
        model: MODELO,
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `Este script de Python para Blender (bpy) falló. Devuelve SOLO el script corregido, sin explicación y sin backticks.

Reglas del entorno:
- Corre dentro de Blender con bpy disponible.
- Existe una función ya inyectada: responder(obj) — llámala con lo que deba volver.
- No uses input() ni nada que bloquee esperando al usuario.
- Blender puede estar en cualquier versión 3.x o 4.x: evita APIs que cambiaron entre versiones si hay alternativa estable.

SCRIPT:
${codigo}

ERROR DE BLENDER:
${ultimoError}`,
        }],
      });
      const txt = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('').trim();
      codigo = txt.replace(/^```(?:python)?\s*/i, '').replace(/```\s*$/, '').trim();
    } catch (e) {
      break;   // sin Claude disponible, no hay más que intentar
    }
  }

  return { ok: false, error: ultimoError, intentos, python: codigo };
}

// ───────────────────────── Builders de operaciones comunes ──────────────────

/** Radiografía de la escena: qué hay, cómo está la cámara, el render, las capas. */
export function pyInfoEscena() {
  return `
import bpy, json
esc = bpy.context.scene
cam = esc.camera
info = {
    "blender": bpy.app.version_string,
    "archivo": bpy.data.filepath or "(sin guardar)",
    "escena": esc.name,
    "frames": {"inicio": esc.frame_start, "fin": esc.frame_end, "actual": esc.frame_current, "fps": esc.render.fps},
    "render": {
        "motor": esc.render.engine,
        "ancho": esc.render.resolution_x,
        "alto": esc.render.resolution_y,
        "porcentaje": esc.render.resolution_percentage,
        "muestras": getattr(getattr(esc, "cycles", None), "samples", None),
        "salida": esc.render.filepath,
    },
    "camara": None if not cam else {
        "nombre": cam.name,
        "posicion": [round(v, 4) for v in cam.location],
        "rotacion": [round(v, 4) for v in cam.rotation_euler],
        "lente_mm": round(cam.data.lens, 2) if cam.type == 'CAMERA' else None,
    },
    "objetos": [
        {"nombre": o.name, "tipo": o.type, "visible": not o.hide_render,
         "posicion": [round(v, 3) for v in o.location],
         "materiales": [m.name for m in o.material_slots.keys()] if hasattr(o, "material_slots") else []}
        for o in esc.objects
    ],
    "materiales": [m.name for m in bpy.data.materials],
    "colecciones": [c.name for c in bpy.data.collections],
}
responder(info)
`.trim();
}

/**
 * Render de un frame (o del rango) a archivo. Devuelve la ruta escrita.
 * `motor` puede ser 'BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE' o 'CYCLES'.
 */
export function pyRender({ salida, frame = null, motor = null, muestras = null, ancho = null, alto = null, animacion = false }) {
  return `
import bpy, os
esc = bpy.context.scene
${motor ? `
# El nombre de EEVEE cambió en Blender 4.2: se prueba el pedido y si no existe,
# se cae al que tenga esta versión, en vez de reventar.
_pedido = ${JSON.stringify(motor)}
_validos = [i.identifier for i in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
esc.render.engine = _pedido if _pedido in _validos else ('CYCLES' if 'CYCLES' in _validos else _validos[0])
` : ''}
${muestras !== null ? `
if hasattr(esc, "cycles"): esc.cycles.samples = ${muestras}
if hasattr(esc, "eevee") and hasattr(esc.eevee, "taa_render_samples"): esc.eevee.taa_render_samples = ${muestras}
` : ''}
${ancho !== null ? `esc.render.resolution_x = ${ancho}` : ''}
${alto !== null ? `esc.render.resolution_y = ${alto}` : ''}
${frame !== null ? `esc.frame_set(${frame})` : ''}

ruta = os.path.expanduser(${JSON.stringify(salida)})
os.makedirs(os.path.dirname(ruta) or ".", exist_ok=True)
esc.render.filepath = ruta
bpy.ops.render.render(animation=${animacion ? 'True' : 'False'}, write_still=${animacion ? 'False' : 'True'})

responder({"ruta": ruta, "motor": esc.render.engine,
           "resolucion": [esc.render.resolution_x, esc.render.resolution_y],
           "animacion": ${animacion ? 'True' : 'False'}})
`.trim();
}

/**
 * Pone una imagen (etiqueta, arte de empaque) sobre un objeto como material PBR.
 * Es la operación base para mockups de producto.
 */
export function pyAplicarEtiqueta({ objeto, imagen, nombreMaterial = 'Etiqueta', rugosidad = 0.35, proyeccion = 'UV' }) {
  return `
import bpy, os
ob = bpy.data.objects.get(${JSON.stringify(objeto)})
if ob is None:
    raise ValueError("No existe el objeto " + ${JSON.stringify(objeto)} + ". Hay: " + ", ".join(o.name for o in bpy.data.objects))

ruta = os.path.expanduser(${JSON.stringify(imagen)})
if not os.path.exists(ruta):
    raise FileNotFoundError("No encuentro la imagen: " + ruta)

mat = bpy.data.materials.get(${JSON.stringify(nombreMaterial)}) or bpy.data.materials.new(${JSON.stringify(nombreMaterial)})
mat.use_nodes = True
nt = mat.node_tree
for n in list(nt.nodes):
    nt.nodes.remove(n)

salida = nt.nodes.new("ShaderNodeOutputMaterial"); salida.location = (400, 0)
bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled");   bsdf.location = (100, 0)
tex = nt.nodes.new("ShaderNodeTexImage");          tex.location = (-250, 0)
tex.image = bpy.data.images.load(ruta, check_existing=True)
${proyeccion === 'BOX' ? 'tex.projection = "BOX"\ntex.projection_blend = 0.2' : ''}

nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = ${rugosidad}
nt.links.new(bsdf.outputs["BSDF"], salida.inputs["Surface"])

if ob.data.materials:
    ob.data.materials[0] = mat
else:
    ob.data.materials.append(mat)

responder({"objeto": ob.name, "material": mat.name, "imagen": ruta,
           "resolucion_textura": list(tex.image.size)})
`.trim();
}

/**
 * Monta iluminación de estudio de producto: fondo infinito, key/fill/rim y una
 * cámara encuadrada al objeto. Es el "set" que convierte un modelo en foto.
 */
export function pyEstudioProducto({ objeto = null, fondo = 0.92, camaraLente = 85, alturaCamara = 0.35 }) {
  return `
import bpy, math
from mathutils import Vector

esc = bpy.context.scene

# Fondo de estudio: un mundo gris parejo, sin HDRI externo que haya que descargar.
if esc.world is None:
    esc.world = bpy.data.worlds.new("Estudio")
esc.world.use_nodes = True
bg = esc.world.node_tree.nodes.get("Background")
if bg:
    bg.inputs[0].default_value = (${fondo}, ${fondo}, ${fondo}, 1.0)
    bg.inputs[1].default_value = 1.0

objetivo = bpy.data.objects.get(${objeto ? JSON.stringify(objeto) : 'None'}) if ${objeto ? 'True' : 'False'} else None
if objetivo is None:
    mallas = [o for o in esc.objects if o.type == 'MESH']
    if not mallas:
        raise ValueError("No hay ningun objeto de malla en la escena que encuadrar.")
    objetivo = max(mallas, key=lambda o: o.dimensions.length)

centro = objetivo.matrix_world.translation
tam = max(objetivo.dimensions) or 1.0

def luz(nombre, tipo, energia, pos, tamano=None):
    d = bpy.data.lights.get(nombre) or bpy.data.lights.new(nombre, type=tipo)
    d.type = tipo; d.energy = energia
    if tamano and hasattr(d, "size"): d.size = tamano
    o = bpy.data.objects.get(nombre)
    if o is None:
        o = bpy.data.objects.new(nombre, d); esc.collection.objects.link(o)
    o.data = d
    o.location = Vector(pos) * tam + centro
    dirv = centro - o.location
    o.rotation_euler = dirv.to_track_quat('-Z', 'Y').to_euler()
    return o

# Key grande y suave al frente-izquierda, fill tenue a la derecha, rim atrás.
luz("Key",  'AREA', 300 * tam * tam, (-1.6, -1.9,  1.5), tamano=tam * 2.6)
luz("Fill", 'AREA',  90 * tam * tam, ( 2.0, -1.3,  0.7), tamano=tam * 2.0)
luz("Rim",  'AREA', 240 * tam * tam, ( 0.4,  2.1,  1.3), tamano=tam * 1.4)

cam = esc.camera
if cam is None:
    cd = bpy.data.cameras.new("CamProducto")
    cam = bpy.data.objects.new("CamProducto", cd)
    esc.collection.objects.link(cam)
    esc.camera = cam
cam.data.lens = ${camaraLente}
cam.location = centro + Vector((0.0, -3.4 * tam, ${alturaCamara} * 2 * tam))
cam.rotation_euler = (centro - cam.location).to_track_quat('-Z', 'Y').to_euler()

responder({"encuadrado": objetivo.name, "tam": round(tam, 4),
           "camara": cam.name, "lente": cam.data.lens,
           "luces": ["Key", "Fill", "Rim"]})
`.trim();
}

/** Importa un modelo (.obj .fbx .glb .gltf .stl .blend) y devuelve qué entró. */
export function pyImportar({ ruta, escala = null }) {
  return `
import bpy, os
ruta = os.path.expanduser(${JSON.stringify(ruta)})
if not os.path.exists(ruta):
    raise FileNotFoundError("No existe: " + ruta)

antes = set(o.name for o in bpy.data.objects)
ext = os.path.splitext(ruta)[1].lower()

if ext == ".obj":
    if hasattr(bpy.ops.wm, "obj_import"): bpy.ops.wm.obj_import(filepath=ruta)   # 4.x
    else: bpy.ops.import_scene.obj(filepath=ruta)                                 # 3.x
elif ext == ".fbx":
    bpy.ops.import_scene.fbx(filepath=ruta)
elif ext in (".glb", ".gltf"):
    bpy.ops.import_scene.gltf(filepath=ruta)
elif ext == ".stl":
    if hasattr(bpy.ops.wm, "stl_import"): bpy.ops.wm.stl_import(filepath=ruta)
    else: bpy.ops.import_mesh.stl(filepath=ruta)
elif ext == ".blend":
    with bpy.data.libraries.load(ruta) as (src, dst):
        dst.objects = src.objects
    for o in dst.objects:
        if o is not None: bpy.context.scene.collection.objects.link(o)
else:
    raise ValueError("Formato no soportado: " + ext)

nuevos = [o for o in bpy.data.objects if o.name not in antes]
${escala !== null ? `
for o in nuevos:
    o.scale = (${escala}, ${escala}, ${escala})
` : ''}
responder({"importados": [o.name for o in nuevos], "archivo": ruta})
`.trim();
}
