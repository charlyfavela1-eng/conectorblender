// blender-app.js — Arranque del conector de Blender como servicio propio.
//
// Existe solo como punto de entrada con nombre claro: toda la app vive en
// blender-server.js (crearApp/arrancar), que ademas arranca solo si lo llaman
// directo. Asi el servicio de Render sube con cualquiera de los dos comandos.
//
//   node blender-app.js
//
// El puente sigue siendo PULL: el addon de Blender jala trabajo desde la maquina
// de Carlos. Por eso este servicio tiene que estar en linea aunque Blender no lo
// este; si se cae, el addon no tiene de donde jalar.
import { arrancar } from './blender-server.js';

arrancar();
