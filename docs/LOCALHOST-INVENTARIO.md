# Inventario localhost

Fecha de revision: 2026-09-01.

## Docker

Contenedores encontrados:

- `n8n-ws`: activo, imagen `docker.n8n.io/n8nio/n8n:stable`, puerto `127.0.0.1:5678`.
- `n8n-ws-postgres`: activo y healthy, imagen `postgres:16-alpine`, solo interno.
- `ws-content-intelligence-postgres`: apagado, imagen `pgvector/pgvector:pg16`, usaria `0.0.0.0:5432` si se prende.

## Puertos importantes

- `3000`: libre para W&S App.
- `5678`: usado por n8n local.
- `7070`: usado por AnyDesk.
- `7679`: usado por Google Drive FS.

## Conclusion

El PC local sirve para pruebas, n8n y vigilantes, pero no como servidor principal de la empresa. Para que todos entren desde celulares y computadores aunque este PC este apagado, la app debe quedar en VPS con Docker.
