// blender-queue.js — Cola en memoria para jobs de Blender.
//
// Mismo patrón que ae-queue.js: el Codespace nunca alcanza la máquina de Carlos,
// así que es el addon de Blender el que JALA trabajo (pull). La cola vive en
// memoria y se reinicia con el servidor, igual que la de AE.
//
// Diferencia con AE: los jobs de Blender pueden tardar minutos (un render de
// Cycles no es un script de dos segundos), así que el heartbeat es más tolerante
// y los jobs guardan progreso.

const jobs = new Map();
let seq = 0;
let lastHeartbeat = null;
let ultimoEstado = null;   // qué está haciendo Blender ahora mismo

// Blender puede tardar minutos en un render y el addon no manda latido mientras
// bloquea. 45 s en vez de los 15 s de AE.
const TOLERANCIA_MS = 45000;

export function createJob(python, meta = {}) {
  const jobId = `bl_${++seq}_${Date.now()}`;
  const job = {
    jobId, python, meta,
    status: 'pending',        // pending | running | completed | failed
    result: null, error: null, progreso: null,
    createdAt: new Date().toISOString(),
    startedAt: null, completedAt: null,
  };
  jobs.set(jobId, job);
  return job;
}

export function getJob(jobId) { return jobs.get(jobId) || null; }

export function getOldestPending() {
  for (const job of jobs.values()) if (job.status === 'pending') return job;
  return null;
}

// El addon marca el job como suyo antes de ejecutarlo, para que dos instancias
// de Blender abiertas a la vez no agarren el mismo trabajo.
export function claimJob(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'pending') return false;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  return true;
}

export function reportProgress(jobId, progreso) {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.progreso = progreso;
  return true;
}

export function completeJob(jobId, result) {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.status = 'completed';
  job.result = result;
  job.completedAt = new Date().toISOString();
  return true;
}

export function failJob(jobId, error) {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.status = 'failed';
  job.error = error;
  job.completedAt = new Date().toISOString();
  return true;
}

// Un job que lleva demasiado tiempo "running" es que Blender se cayó o se cerró
// a media faena: se libera para que no bloquee la cola en silencio.
export function liberarColgados(maxMs = 15 * 60 * 1000) {
  const ahora = Date.now();
  const liberados = [];
  for (const job of jobs.values()) {
    if (job.status === 'running' && ahora - new Date(job.startedAt).getTime() > maxMs) {
      job.status = 'failed';
      job.error = 'Blender no contestó: se cerró o se quedó colgado a media tarea.';
      job.completedAt = new Date().toISOString();
      liberados.push(job.jobId);
    }
  }
  return liberados;
}

export function touchHeartbeat(estado) {
  lastHeartbeat = Date.now();
  if (estado) ultimoEstado = estado;
}

export function isConnected() {
  return lastHeartbeat !== null && Date.now() - lastHeartbeat < TOLERANCIA_MS;
}

export function getEstado() {
  return {
    conectado: isConnected(),
    ultimoLatido: lastHeartbeat ? new Date(lastHeartbeat).toISOString() : null,
    blender: ultimoEstado,
    pendientes: [...jobs.values()].filter((j) => j.status === 'pending').length,
    corriendo: [...jobs.values()].filter((j) => j.status === 'running').length,
  };
}

export function getAllJobs() { return [...jobs.values()]; }
