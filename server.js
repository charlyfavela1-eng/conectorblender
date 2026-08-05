// server.js — el mismo arranque que blender-app.js, con el nombre que Render busca.
//
// Por que existe este archivo teniendo ya blender-app.js: el Start Command del
// servicio en el panel de Render dice `node server.js`, y eso MANDA sobre el
// startCommand del render.yaml. El yaml solo lo lee Render cuando el servicio se
// crea como Blueprint; en uno hecho a mano, la casilla del panel gana siempre.
// Resultado del 2026-08-05: build correcto y despues
//
//   Error: Cannot find module '/opt/render/project/src/server.js'
//
// Se puede arreglar en el panel cambiando el Start Command a
// `node blender-app.js`, pero eso hay que acordarse de hacerlo cada vez que se
// recree el servicio. Tener los dos nombres apuntando al mismo arranque lo deja
// resuelto desde el repo: suba con `node server.js`, con `node blender-app.js`
// o con `npm start`, arranca lo mismo.
import { arrancar } from './blender-server.js';

arrancar();
