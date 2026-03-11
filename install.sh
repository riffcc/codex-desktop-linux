#!/bin/bash
set -Eeuo pipefail

# ============================================================================
# Codex Desktop for Linux — Installer
# Converts the official macOS Codex Desktop app to run on Linux
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${CODEX_INSTALL_DIR:-$SCRIPT_DIR/codex-app}"
ELECTRON_VERSION="40.0.0"
WORK_DIR="$(mktemp -d)"
ARCH="$(uname -m)"
DESKTOP_ENTRY_ID="riff-codex-desktop"
DESKTOP_APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP_ICONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*" >&2; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

cleanup() {
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT
trap 'error "Failed at line $LINENO (exit code $?)"' ERR

# ---- Check dependencies ----
check_deps() {
    local missing=()
    for cmd in node npm npx cargo 7z curl unzip; do
        command -v "$cmd" &>/dev/null || missing+=("$cmd")
    done
    if [ ${#missing[@]} -ne 0 ]; then
        error "Missing dependencies: ${missing[*]}
Install them first:
  sudo apt install nodejs npm cargo rustc p7zip-full curl unzip build-essential  # Debian/Ubuntu
  sudo dnf install nodejs npm cargo rust p7zip curl unzip && sudo dnf groupinstall 'Development Tools'  # Fedora
  sudo pacman -S nodejs npm cargo rust p7zip curl unzip base-devel  # Arch"
    fi

    NODE_MAJOR=$(node -v | cut -d. -f1 | tr -d v)
    if [ "$NODE_MAJOR" -lt 20 ]; then
        error "Node.js 20+ required (found $(node -v))"
    fi

    if ! command -v make &>/dev/null || ! command -v g++ &>/dev/null; then
        error "Build tools (make, g++) required:
  sudo apt install build-essential   # Debian/Ubuntu
  sudo dnf groupinstall 'Development Tools'  # Fedora
  sudo pacman -S base-devel          # Arch"
    fi

    info "All dependencies found"
}

# ---- Download or find Codex DMG ----
get_dmg() {
    local dmg_dest="$SCRIPT_DIR/Codex.dmg"

    # Reuse existing DMG
    if [ -s "$dmg_dest" ]; then
        info "Using cached DMG: $dmg_dest ($(du -h "$dmg_dest" | cut -f1))"
        echo "$dmg_dest"
        return
    fi

    info "Downloading Codex Desktop DMG..."
    local dmg_url="https://persistent.oaistatic.com/codex-app-prod/Codex.dmg"
    info "URL: $dmg_url"

    if ! curl -L --progress-bar --max-time 600 --connect-timeout 30 \
            -o "$dmg_dest" "$dmg_url"; then
        rm -f "$dmg_dest"
        error "Download failed. Download manually and place as: $dmg_dest"
    fi

    if [ ! -s "$dmg_dest" ]; then
        rm -f "$dmg_dest"
        error "Download produced empty file. Download manually and place as: $dmg_dest"
    fi

    info "Saved: $dmg_dest ($(du -h "$dmg_dest" | cut -f1))"
    echo "$dmg_dest"
}

# ---- Extract app from DMG ----
extract_dmg() {
    local dmg_path="$1"
    info "Extracting DMG with 7z..."

    7z x -y "$dmg_path" -o"$WORK_DIR/dmg-extract" >&2 || \
        error "Failed to extract DMG"

    local app_dir
    app_dir=$(find "$WORK_DIR/dmg-extract" -maxdepth 3 -name "*.app" -type d | head -1)
    [ -n "$app_dir" ] || error "Could not find .app bundle in DMG"

    info "Found: $(basename "$app_dir")"
    echo "$app_dir"
}

# ---- Build native modules in a clean directory ----
build_native_modules() {
    local app_extracted="$1"

    # Read versions from extracted app
    local bs3_ver npty_ver
    bs3_ver=$(node -p "require('$app_extracted/node_modules/better-sqlite3/package.json').version" 2>/dev/null || echo "")
    npty_ver=$(node -p "require('$app_extracted/node_modules/node-pty/package.json').version" 2>/dev/null || echo "")

    [ -n "$bs3_ver" ] || error "Could not detect better-sqlite3 version"
    [ -n "$npty_ver" ] || error "Could not detect node-pty version"

    info "Native modules: better-sqlite3@$bs3_ver, node-pty@$npty_ver"

    # Build in a CLEAN directory (asar doesn't have full source)
    local build_dir="$WORK_DIR/native-build"
    mkdir -p "$build_dir"
    cd "$build_dir"

    echo '{"private":true}' > package.json

    info "Installing fresh sources from npm..."
    npm install "electron@$ELECTRON_VERSION" --save-dev --ignore-scripts 2>&1 >&2
    npm install "better-sqlite3@$bs3_ver" "node-pty@$npty_ver" --ignore-scripts 2>&1 >&2

    info "Compiling for Electron v$ELECTRON_VERSION (this takes ~1 min)..."
    npx --yes @electron/rebuild -v "$ELECTRON_VERSION" --force 2>&1 >&2

    info "Native modules built successfully"

    # Copy compiled modules back into extracted app
    rm -rf "$app_extracted/node_modules/better-sqlite3"
    rm -rf "$app_extracted/node_modules/node-pty"
    cp -r "$build_dir/node_modules/better-sqlite3" "$app_extracted/node_modules/"
    cp -r "$build_dir/node_modules/node-pty" "$app_extracted/node_modules/"
}

# ---- Extract and patch app.asar ----
patch_asar() {
    local app_dir="$1"
    local resources_dir="$app_dir/Contents/Resources"

    [ -f "$resources_dir/app.asar" ] || error "app.asar not found in $resources_dir"

    info "Extracting app.asar..."
    cd "$WORK_DIR"
    npx --yes asar extract "$resources_dir/app.asar" app-extracted

    # Copy unpacked native modules if they exist
    if [ -d "$resources_dir/app.asar.unpacked" ]; then
        cp -r "$resources_dir/app.asar.unpacked/"* app-extracted/ 2>/dev/null || true
    fi

    # Remove macOS-only modules
    rm -rf "$WORK_DIR/app-extracted/node_modules/sparkle-darwin" 2>/dev/null || true
    find "$WORK_DIR/app-extracted" -name "sparkle.node" -delete 2>/dev/null || true

    # Make Linux windows explicitly resizable in the extracted Electron bundle.
    local main_bundle="$WORK_DIR/app-extracted/.vite/build/main.js"
    if [ -f "$main_bundle" ]; then
        python3 - "$main_bundle" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
replacements = [
    (
        "e===`secondary`?{titleBarStyle:`default`}",
        "e===`secondary`?{titleBarStyle:`default`,resizable:!0}",
    ),
    (
        "e===`hud`?{titleBarStyle:`default`,minimizable:!1,maximizable:!1,fullscreenable:!1,alwaysOnTop:!0}",
        "e===`hud`?{titleBarStyle:`default`,resizable:!0,minimizable:!1,maximizable:!1,fullscreenable:!1,alwaysOnTop:!0}",
    ),
    (
        ":{titleBarStyle:`default`})",
        ":{titleBarStyle:`default`,resizable:!0})",
    ),
    (
        "backgroundColor:S,show:a,",
        "backgroundColor:S,show:a,resizable:!0,",
    ),
    (
        "backgroundColor:S,show:a,...process.platform===`win32`?{autoHideMenuBar:!0}:{}",
        "backgroundColor:S,show:a,resizable:!0,...process.platform===`win32`?{autoHideMenuBar:!0}:{}",
    ),
]

for needle, replacement in replacements:
    if needle in text:
        text = text.replace(needle, replacement, 1)

runtime_replacements = [
    ("n.setResizable(!1),n.setMaximizable(!1),n.setFullScreenable(!1),", "n.setResizable(!0),n.setMaximizable(!0),n.setFullScreenable(!0),"),
]

for needle, replacement in runtime_replacements:
    if needle in text:
        text = text.replace(needle, replacement, 1)

zoom_segment = "let Oe=e?[]:[{role:`zoomIn`,accelerator:`Ctrl+=`,acceleratorWorksWhenHidden:!0,visible:!1}];De.push({type:`separator`},{role:`zoomIn`},...Oe,{role:`zoomOut`},{role:`resetZoom`},{type:`separator`},{role:`togglefullscreen`}),"
zoom_replacement = (
    "let Oe=e?[]:[{label:`Zoom In`,accelerator:`Ctrl+=`,acceleratorWorksWhenHidden:!0,visible:!1,click:async()=>{let e=await h();if(e){let t=e.webContents,n=Math.min(3,(t.getZoomFactor?.()??1)+.1);t.setZoomFactor(n),t.invalidate?.(),await t.executeJavaScript?.(\"window.dispatchEvent(new Event('resize'));document.documentElement&&document.documentElement.getBoundingClientRect();\",!0).catch(()=>{}),e.focus()}}}];"
    "let Re=async e=>{let t=await h();if(!t)return;let n=t.webContents,r=e(n.getZoomFactor?.()??1);n.setZoomFactor(r),n.invalidate?.(),await n.executeJavaScript?.(\"window.dispatchEvent(new Event('resize'));document.documentElement&&document.documentElement.getBoundingClientRect();\",!0).catch(()=>{}),t.focus()};"
    "De.push({type:`separator`},{label:`Zoom In`,accelerator:`CmdOrCtrl+Plus`,click:async()=>{await Re(e=>Math.min(3,e+.1))}},...Oe,{label:`Zoom Out`,accelerator:`CmdOrCtrl+-`,click:async()=>{await Re(e=>Math.max(.5,e-.1))}},{label:`Actual Size`,accelerator:`CmdOrCtrl+0`,click:async()=>{await Re(()=>1)}},{type:`separator`},{role:`togglefullscreen`}),"
)

if zoom_segment in text:
    text = text.replace(zoom_segment, zoom_replacement, 1)

workspace_warning = "async function hD(e,t,n){return Promise.all(e.map(async e=>{try{return await gD(Up(e),t,n)}catch(t){return vg().warning(`[git-origin-and-roots] Failed to resolve origin for workspace`,{safe:{},sensitive:{error:t}}),{dir:Up(e),root:Hp(e),originUrl:null,commonDir:null}}}))}"
workspace_warning_replacement = "async function hD(e,t,n){return Promise.all(e.map(async e=>{try{return await gD(Up(e),t,n)}catch(t){let n=`${t?.message??t}`;return n.includes(`path does not exist`)?{dir:Up(e),root:Hp(e),originUrl:null,commonDir:null}:(vg().warning(`[git-origin-and-roots] Failed to resolve origin for workspace`,{safe:{},sensitive:{error:t}}),{dir:Up(e),root:Hp(e),originUrl:null,commonDir:null})}}))}"
if workspace_warning in text:
    text = text.replace(workspace_warning, workspace_warning_replacement, 1)

message_handler = "if(await R9.handleMessage(e,t))return;let n=L9.getContextForWebContents(e.sender);if(!n){vg().warning(`Message received for unknown window context`);return}await n.handleMessage(e.sender,t)"
message_handler_replacement = "if(await R9.handleMessage(e,t))return;let n=L9.getContextForWebContents(e.sender);if(!n){vg().warning(`Message received for unknown window context`);return}try{await n.handleMessage(e.sender,t)}catch(r){if(!`${r?.message??r}`.includes(`Object has been destroyed`))throw r;vg().debug?.(`[electron-message-handler] Ignored destroyed target during message handling`)}}"
if message_handler in text:
    text = text.replace(message_handler, message_handler_replacement, 1)

path.write_text(text)
PY
        info "Patched Linux window chrome to be explicitly resizable"
    else
        warn "Main Electron bundle not found at $main_bundle; skipping resize patch"
    fi

    # Build native modules in clean environment and copy back
    build_native_modules "$WORK_DIR/app-extracted"

    # Repack
    info "Repacking app.asar..."
    cd "$WORK_DIR"
    npx asar pack app-extracted app.asar --unpack "{*.node,*.so,*.dylib}" 2>/dev/null

    info "app.asar patched"
}

# ---- Download Linux Electron ----
download_electron() {
    info "Downloading Electron v${ELECTRON_VERSION} for Linux..."

    local electron_arch
    case "$ARCH" in
        x86_64)  electron_arch="x64" ;;
        aarch64) electron_arch="arm64" ;;
        armv7l)  electron_arch="armv7l" ;;
        *)       error "Unsupported architecture: $ARCH" ;;
    esac

    local url="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-linux-${electron_arch}.zip"

    curl -L --progress-bar -o "$WORK_DIR/electron.zip" "$url"
    mkdir -p "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    unzip -qo "$WORK_DIR/electron.zip"

    info "Electron ready"
}

# ---- Extract webview files ----
extract_webview() {
    local app_dir="$1"
    mkdir -p "$INSTALL_DIR/content/webview"

    # Webview files are inside the extracted asar at webview/
    local asar_extracted="$WORK_DIR/app-extracted"
    if [ -d "$asar_extracted/webview" ]; then
        cp -r "$asar_extracted/webview/"* "$INSTALL_DIR/content/webview/"
        if [ -f "$SCRIPT_DIR/controller-shim.js" ]; then
            cp "$SCRIPT_DIR/controller-shim.js" "$INSTALL_DIR/content/webview/assets/controller-shim.js"
        fi
        if [ -f "$SCRIPT_DIR/vendor/gamepad_standardizer.esm.js" ]; then
            cp "$SCRIPT_DIR/vendor/gamepad_standardizer.esm.js" \
                "$INSTALL_DIR/content/webview/assets/gamepad_standardizer.esm.js"
        fi
        if [ -f "$INSTALL_DIR/content/webview/index.html" ]; then
            python3 - "$INSTALL_DIR/content/webview/index.html" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
snippet = '    <script type="module" src="./assets/controller-shim.js"></script>\n'
needle = '    <script type="module" crossorigin src="./assets/index-CMu6BCpo.js"></script>\n'

if snippet not in text and needle in text:
    text = text.replace(needle, snippet + needle, 1)

path.write_text(text)
PY
        fi
        info "Webview files copied"
    else
        warn "Webview directory not found in asar — app may not work"
    fi
}

# ---- Install app.asar ----
install_app() {
    cp "$WORK_DIR/app.asar" "$INSTALL_DIR/resources/"
    if [ -d "$WORK_DIR/app.asar.unpacked" ]; then
        cp -r "$WORK_DIR/app.asar.unpacked" "$INSTALL_DIR/resources/"
    fi
    info "app.asar installed"
}

# ---- Create start script ----
create_start_script() {
    cargo build --release --manifest-path "$SCRIPT_DIR/Cargo.toml" >&2

    install -Dm755 "$SCRIPT_DIR/target/release/codex-desktop-linux" "$INSTALL_DIR/codex-desktop-linux"

    cat > "$INSTALL_DIR/start.sh" << 'SCRIPT'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RIFF_CODEX_CLI_PATH="${RIFF_CODEX_CLI_PATH:-$HOME/.local/bin/riff-codex}"
CODEX_TUI_HANDY_PRESS_CMD="${CODEX_TUI_HANDY_PRESS_CMD:-xdotool keydown ctrl+space}"
CODEX_TUI_HANDY_RELEASE_CMD="${CODEX_TUI_HANDY_RELEASE_CMD:-xdotool keyup ctrl+space}"

export CODEX_TUI_HANDY_PRESS_CMD
export CODEX_TUI_HANDY_RELEASE_CMD

if [ -z "${CODEX_CLI_PATH:-}" ] && [ -x "$RIFF_CODEX_CLI_PATH" ]; then
    export CODEX_CLI_PATH="$RIFF_CODEX_CLI_PATH"
fi

exec "$SCRIPT_DIR/codex-desktop-linux" "$@"
SCRIPT

    chmod +x "$INSTALL_DIR/start.sh"
    info "Rust launcher and start script created"
}

# ---- Install desktop entry ----
install_desktop_entry() {
    local icon_source="$INSTALL_DIR/content/webview/assets/app-D0g8sCle.png"
    local icon_target="$DESKTOP_ICONS_DIR/${DESKTOP_ENTRY_ID}.png"
    local desktop_target="$DESKTOP_APPS_DIR/${DESKTOP_ENTRY_ID}.desktop"

    if [ ! -f "$icon_source" ]; then
        warn "Codex app icon not found at $icon_source; skipping desktop entry"
        return
    fi

    mkdir -p "$DESKTOP_APPS_DIR" "$DESKTOP_ICONS_DIR"
    install -Dm644 "$icon_source" "$icon_target"

    cat > "$desktop_target" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Codex Desktop
Comment=Codex Desktop for Linux with Riff runtime compatibility
Exec=$INSTALL_DIR/start.sh
Icon=$DESKTOP_ENTRY_ID
Terminal=false
Categories=Development;Utility;
StartupNotify=true
EOF

    info "Desktop entry installed at $desktop_target"
}

# ---- Main ----
main() {
    echo "============================================" >&2
    echo "  Codex Desktop for Linux — Installer"       >&2
    echo "============================================" >&2
    echo ""                                             >&2

    check_deps

    local dmg_path=""
    if [ $# -ge 1 ] && [ -f "$1" ]; then
        dmg_path="$(realpath "$1")"
        info "Using provided DMG: $dmg_path"
    else
        dmg_path=$(get_dmg)
    fi

    local app_dir
    app_dir=$(extract_dmg "$dmg_path")

    patch_asar "$app_dir"
    download_electron
    extract_webview "$app_dir"
    install_app
    create_start_script
    install_desktop_entry

    if [ ! -x "${RIFF_CODEX_CLI_PATH:-$HOME/.local/bin/riff-codex}" ] && ! command -v codex &>/dev/null; then
        warn "Codex CLI not found. Install the Riff fork to ~/.local/bin/riff-codex or set CODEX_CLI_PATH."
    fi

    echo ""                                             >&2
    echo "============================================" >&2
    info "Installation complete!"
    echo "  Run:  $INSTALL_DIR/start.sh"                >&2
    echo "============================================" >&2
}

main "$@"
