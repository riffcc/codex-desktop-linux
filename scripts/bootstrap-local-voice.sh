#!/bin/bash
set -u

if [ "${RIFF_CODEX_AUTO_BOOTSTRAP_LOCAL_VOICE:-1}" = "0" ]; then
    exit 0
fi

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"

MODEL_ID="${RIFF_CODEX_LOCAL_VOICE_MODEL_ID:-parakeet-tdt-0.6b-v3}"
MODEL_DIRNAME="${RIFF_CODEX_LOCAL_VOICE_MODEL_DIRNAME:-parakeet-tdt-0.6b-v3-int8}"
MODEL_URL="${RIFF_CODEX_LOCAL_VOICE_MODEL_URL:-https://blob.handy.computer/parakeet-v3-int8.tar.gz}"

HANDY_ROOT="${RIFF_CODEX_LOCAL_VOICE_ROOT:-$DATA_HOME/com.pais.handy}"
MODELS_DIR="$HANDY_ROOT/models"
MODEL_DIR="$MODELS_DIR/$MODEL_DIRNAME"
SETTINGS_PATH="$HANDY_ROOT/settings_store.json"
READY_MARKER="$MODEL_DIR/encoder-model.int8.onnx"

ARCHIVE_DIR="${RIFF_CODEX_LOCAL_VOICE_CACHE_DIR:-$CACHE_HOME/riff-codex}"
ARCHIVE_PATH="$ARCHIVE_DIR/${MODEL_DIRNAME}.tar.gz"
LOG_DIR="${RIFF_CODEX_LOCAL_VOICE_LOG_DIR:-$STATE_HOME/riff-codex}"
LOG_PATH="$LOG_DIR/bootstrap-local-voice.log"
LOCK_DIR="$LOG_DIR/bootstrap-local-voice.lock"

log() {
    mkdir -p "$LOG_DIR" 2>/dev/null || true
    printf '[%s] %s\n' "$(date -Is)" "$*" >> "$LOG_PATH"
}

write_settings() {
    mkdir -p "$HANDY_ROOT" 2>/dev/null || return 1
    cat > "$SETTINGS_PATH" <<EOF
{"settings":{"selected_language":"auto","selected_model":"$MODEL_ID","translate_to_english":false}}
EOF
}

if [ -f "$READY_MARKER" ] && [ -f "$SETTINGS_PATH" ]; then
    exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
    log "skipping bootstrap: curl is unavailable"
    exit 0
fi

if ! command -v tar >/dev/null 2>&1; then
    log "skipping bootstrap: tar is unavailable"
    exit 0
fi

mkdir -p "$MODELS_DIR" "$ARCHIVE_DIR" "$LOG_DIR" 2>/dev/null || true

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "bootstrap already in progress"
    exit 0
fi

cleanup() {
    rm -rf "$LOCK_DIR"
}
trap cleanup EXIT

TMP_DIR="$(mktemp -d "$ARCHIVE_DIR/bootstrap.XXXXXX")" || {
    log "failed to allocate temporary directory"
    exit 0
}
trap 'rm -rf "$TMP_DIR"; cleanup' EXIT

if [ ! -f "$ARCHIVE_PATH" ]; then
    log "downloading local voice model from $MODEL_URL"
    if ! curl -fL --retry 3 --connect-timeout 15 --max-time 1800 -o "$ARCHIVE_PATH.tmp" "$MODEL_URL"; then
        rm -f "$ARCHIVE_PATH.tmp"
        log "download failed"
        exit 0
    fi
    mv "$ARCHIVE_PATH.tmp" "$ARCHIVE_PATH"
fi

log "extracting local voice model to $MODELS_DIR"
if ! tar -xzf "$ARCHIVE_PATH" -C "$TMP_DIR"; then
    log "extract failed"
    exit 0
fi

if [ ! -d "$TMP_DIR/$MODEL_DIRNAME" ]; then
    log "archive missing expected directory $MODEL_DIRNAME"
    exit 0
fi

rm -rf "$MODEL_DIR"
mv "$TMP_DIR/$MODEL_DIRNAME" "$MODEL_DIR"

if write_settings; then
    log "local voice bootstrap complete"
else
    log "local voice model installed but failed to write settings"
fi
