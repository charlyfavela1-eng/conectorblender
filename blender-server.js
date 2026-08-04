// blender-server.js — Endpoints del puente Codespace ↔ Blender.
//
// Igual que el de AE, el puente es PULL: el Codespace nunca alcanza la máquina
// de Carlos, así que es el addon de Blender el que jala trabajo.
//
//   Addon (local)  →  GET  /api/blender/pending?key=    toma el siguiente job
//                  →  POST /api/blender/result?key=     devuelve resultado o error
//                  →  POST /api/blender/heartbeat?key=  señal de vida + estado
//                  →  POST /api/blender/progress?key=   avance de un render largo
//
//   Claude/UI      →  POST /api/blender/execute         Python arbitrario
//                  →  POST /api/blender/scene           radiografía de la escena
//                  →  POST /api/blender/render          render a archivo
//                  →  POST /api/blender/producto        set de estudio + etiqueta
//                  →  POST /api/blender/import          importar modelo
//                  →  GET  /api/blender/status          conexión y cola
//
// Los endpoints del addon exigen ?key=$CLAUDE_KEY. Los de control no llevan auth,
// igual que en AE (es una app personal, ver "Patrones" en CLAUDE.md).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  createJob, getJob, getOldestPending, claimJob, completeJob, failJob,
  reportProgress, touchHeartbeat, getEstado, getAllJobs, liberarColgados,
} from './blender-queue.js';
import {
  ejecutarEnBlender, pyInfoEscena, pyRender, pyAplicarEtiqueta,
  pyEstudioProducto, pyImportar,
} from './blender-connector.js';

export function mountBlenderServer(app) {
  function auth(req, res, next) {
    const esperada = process.env.CLAUDE_KEY;
    if (!esperada) return res.status(500).json({ error: 'CLAUDE_KEY no configurada' });
    if (req.query.key !== esperada) return res.status(401).json({ error: 'No autorizado' });
    next();
  }

  // Si Blender se cerró a media faena, sus jobs quedan colgados y taparían la
  // cola en silencio. Se revisa en cada consulta, que es barato.
  function limpiar() { liberarColgados(); }

  // ─────────────────────────── Lado del addon ───────────────────────────────

  app.get('/api/blender/pending', auth, (req, res) => {
    limpiar();
    touchHeartbeat(req.query.estado || null);
    const job = getOldestPending();
    if (!job) return res.json({ job: null });
    claimJob(job.jobId);
    res.json({ job: { jobId: job.jobId, python: job.python, meta: job.meta } });
  });

  app.post('/api/blender/result', auth, (req, res) => {
    const { jobId, result, error } = req.body || {};
    if (!jobId) return res.status(400).json({ error: 'falta jobId' });
    touchHeartbeat();
    if (error) { failJob(jobId, String(error)); return res.json({ ok: true, estado: 'failed' }); }
    completeJob(jobId, result ?? null);
    res.json({ ok: true, estado: 'completed' });
  });

  app.post('/api/blender/heartbeat', auth, (req, res) => {
    touchHeartbeat(req.body?.estado || null);
    limpiar();
    res.json({ ok: true, ...getEstado() });
  });

  app.post('/api/blender/progress', auth, (req, res) => {
    const { jobId, progreso } = req.body || {};
    touchHeartbeat();
    if (jobId) reportProgress(jobId, progreso);
    res.json({ ok: true });
  });

  // ────────────────────────── Lado de control ───────────────────────────────

  // Envoltorio común: si Blender no está conectado, se dice de una vez en vez de
  // dejar la petición colgada doce minutos esperando a nadie.
  async function correr(res, python, meta) {
    if (!getEstado().conectado) {
      return res.status(503).json({
        error: 'Blender no está conectado.',
        comoArreglar: 'Abre Blender, ve a la pestaña Seedance en la barra lateral (tecla N) y dale Conectar.',
      });
    }
    try {
      const r = await ejecutarEnBlender(python, meta);
      res.status(r.ok ? 200 : 500).json(r);
    } catch (e) {
      res.status(504).json({ error: e.message });
    }
  }

  // Python arbitrario: es el equivalente de /api/ae/execute y lo que permite
  // "tirar órdenes de funciones complejas" sin tener que añadir un endpoint nuevo.
  app.post('/api/blender/execute', async (req, res) => {
    const { python, meta } = req.body || {};
    if (!python) return res.status(400).json({ error: 'falta python' });
    await correr(res, python, meta || { tipo: 'libre' });
  });

  app.post('/api/blender/scene', async (_req, res) => {
    await correr(res, pyInfoEscena(), { tipo: 'info' });
  });

  app.post('/api/blender/render', async (req, res) => {
    const { salida, frame, motor, muestras, ancho, alto, animacion } = req.body || {};
    if (!salida) return res.status(400).json({ error: 'falta salida (ruta del archivo)' });
    await correr(res, pyRender({ salida, frame, motor, muestras, ancho, alto, animacion }), { tipo: 'render', salida });
  });

  app.post('/api/blender/import', async (req, res) => {
    const { ruta, escala } = req.body || {};
    if (!ruta) return res.status(400).json({ error: 'falta ruta' });
    await correr(res, pyImportar({ ruta, escala }), { tipo: 'import', ruta });
  });

  // Mockup de producto en una sola llamada: monta el estudio, pega la etiqueta y
  // renderiza. Es la operación que más se va a repetir con los clientes.
  app.post('/api/blender/producto', async (req, res) => {
    const { objeto, etiqueta, salida, muestras = 128, motor = 'CYCLES', rugosidad, proyeccion, lente } = req.body || {};
    const pasos = [pyEstudioProducto({ objeto, camaraLente: lente || 85 })];
    if (etiqueta && objeto) pasos.push(pyAplicarEtiqueta({ objeto, imagen: etiqueta, rugosidad, proyeccion }));
    if (salida) pasos.push(pyRender({ salida, motor, muestras }));

    // Se manda como UN script para que sea una sola ida y vuelta a Blender.
    const python = pasos.map((p, i) =>
      // Cada bloque llama responder(); sólo debe valer el último, así que los
      // intermedios se neutralizan guardando su salida en una lista.
      p.replace(/responder\(/g, `_r${i}.append(`)
    ).join('\n\n');

    const envoltura = `
${pasos.map((_, i) => `_r${i} = []`).join('\n')}
${python}
responder({${pasos.map((_, i) => `"paso${i}": (_r${i}[0] if _r${i} else None)`).join(', ')}})
`.trim();

    await correr(res, envoltura, { tipo: 'producto', objeto, salida });
  });

  app.get('/api/blender/status', (_req, res) => {
    limpiar();
    res.json({
      ...getEstado(),
      jobs: getAllJobs().slice(-20).map((j) => ({
        jobId: j.jobId, estado: j.status, tipo: j.meta?.tipo,
        creado: j.createdAt, terminado: j.completedAt,
        progreso: j.progreso, error: j.error,
      })),
    });
  });

  // El addon se descarga desde aquí, así no hay que pasarlo por WhatsApp.
  app.get('/api/blender/addon', (_req, res) => {
    // Content-Disposition obligatorio: sin el, el navegador guarda el archivo con
    // el nombre de la RUTA ("addon", sin extension) y Blender no lo instala,
    // porque exige .py o .zip.
    res.set('Content-Type', 'text/x-python; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="seedance_blender.py"');
    res.sendFile('seedance_blender.py', { root: './blender-addon' }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'addon no encontrado en blender-addon/' });
    });
  });

  console.log('Blender connector montado en /api/blender/*');
}

// Arranque como servicio propio -------------------------------------------
// mountBlenderServer solo monta rutas sobre una app ajena. Cuando el conector es
// su propio servicio en Render hace falta ademas crear la app y abrir el puerto.

export function crearApp() {
  const app = express();
  app.disable('x-powered-by');
  // El addon manda resultados de render en base64; el limite por defecto (100 kb)
  // los rechaza.
  app.use(express.json({ limit: '50mb' }));

  // Para el monitor de Render y para saber de un vistazo que esta arriba.
  app.get('/salud', (_req, res) => res.json({ ok: true, servicio: 'blender-connector' }));

  // La raiz contesta algo legible: entrar a la URL y ver un 404 hace pensar que
  // el servicio esta caido cuando no lo esta.
  app.get('/', (_req, res) => {
    res.type('text/plain').send(
      'Conector de Blender.\n\n'
      + 'Addon:  GET /api/blender/addon\n'
      + 'Estado: GET /api/blender/status\n'
      + 'Salud:  GET /salud\n',
    );
  });

  mountBlenderServer(app);
  return app;
}

export function arrancar() {
  // Render inyecta PORT; el valor local sirve para probar sin variables.
  const puerto = process.env.PORT || 10001;
  return crearApp().listen(puerto, () => console.log(`Conector de Blender escuchando en ${puerto}`));
}

// El Start Command en Render quedo como `node blender-server.js`, y como este
// archivo solo exportaba, el proceso importaba, no abria puerto y salia — de ahi
// el 502 de conectorblender.onrender.com. Con este guard arranca igual lo llamen
// a el o a blender-app.js, sin depender de tocar el panel de Render.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  arrancar();
}
