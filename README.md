# Conector de Blender

Puente PULL entre el estudio y Blender: el addon corre en la maquina de Carlos y
jala trabajo de este servicio. Vive aparte del repo del estudio porque aquel pesa
1.4 GB y Render no lo termina de clonar.

    npm install && node blender-app.js     # local, puerto 10001

Endpoints: `GET /salud`, `GET /api/blender/addon`, `GET /api/blender/status`.
Los del addon exigen `?key=$CLAUDE_KEY`.

El codigo fuente vive en el repo del estudio (VisionagenciaIAv2.0); aqui se copia
para desplegar.
