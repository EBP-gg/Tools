#!/bin/sh
# Lance Tools en MODE SYSTÈME (pré-analyse des vidéos de salle) contre la PROD.
#
# La clé système est à la fois le credential et l'interrupteur du worker
# (electron/services/system-worker-service.js) : sans elle, start() est un no-op.
# Elle est lue dans .ebp-system-key (gitignoré) plutôt qu'écrite ici.
#
# ATTENTION : ce mode écrit RÉELLEMENT en prod.
set -e
cd "$(dirname "$0")/.."
# Un terminal intégré VS Code exporte ELECTRON_RUN_AS_NODE=1, ce qui fait tourner
# le binaire Electron comme un simple Node : `app` est alors undefined et le
# chargement de config/constants.js échoue avant tout démarrage de service.
unset ELECTRON_RUN_AS_NODE
TOOLS_SYSTEM_KEY=$(tr -d '\r\n' < .ebp-system-key)
export TOOLS_SYSTEM_KEY
EBP_TARGET=prod
export EBP_TARGET
exec npm start
