#!/usr/bin/env bash
# OASIS installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/FAHTHIZ/Oasis-/main/install.sh | bash
#
# Options (flags after `bash -s --`, or environment variables):
#   --with-tools        also install language servers for TypeScript, Python, Bash, YAML, JSON/HTML/CSS
#                       (and gopls / rust-analyzer when Go / rustup are present)   OASIS_WITH_TOOLS=1
#   --branch <name>     install a branch or tag instead of main                     OASIS_BRANCH
#   --dir <path>        where OASIS lives (default ~/.oasis)                         OASIS_HOME
#   --bin-dir <path>    where the `oasis` command goes (default ~/.local/bin)        OASIS_BIN_DIR
#   --no-modify-path    do not add the bin dir to your shell profile                 OASIS_NO_MODIFY_PATH=1
#   --uninstall         remove the app, private Node.js, tools and the `oasis` command (keeps settings and sessions)
#
# Running it again updates an existing install. Nothing needs sudo.
set -euo pipefail

REPO_URL="${OASIS_REPO:-https://github.com/FAHTHIZ/Oasis-.git}"
BRANCH="${OASIS_BRANCH:-main}"
OASIS_HOME="${OASIS_HOME:-$HOME/.oasis}"
BIN_DIR="${OASIS_BIN_DIR:-$HOME/.local/bin}"
WITH_TOOLS="${OASIS_WITH_TOOLS:-0}"
MODIFY_PATH=1
[ "${OASIS_NO_MODIFY_PATH:-0}" = "1" ] && MODIFY_PATH=0
UNINSTALL=0
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=19
NODE_VERSION="${OASIS_NODE_VERSION:-22.21.1}"

while [ $# -gt 0 ]; do
	case "$1" in
	--with-tools) WITH_TOOLS=1 ;;
	--branch) BRANCH="$2"; shift ;;
	--dir) OASIS_HOME="$2"; shift ;;
	--bin-dir) BIN_DIR="$2"; shift ;;
	--no-modify-path) MODIFY_PATH=0 ;;
	--uninstall) UNINSTALL=1 ;;
	-h | --help) sed -n '2,16p' "$0" 2>/dev/null || true; exit 0 ;;
	*) echo "oasis-install: unknown option $1" >&2; exit 2 ;;
	esac
	shift
done

APP_DIR="$OASIS_HOME/app"
NODE_DIR="$OASIS_HOME/node"
TOOLS_DIR="$OASIS_HOME/tools"

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'; else B= G= Y= R= D= N=; fi
say() { printf '%s\n' "${B}==>${N} $*"; }
warn() { printf '%s\n' "${Y}warning:${N} $*" >&2; }
die() { printf '%s\n' "${R}error:${N} $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

if [ "$UNINSTALL" = "1" ]; then
	rm -rf "$APP_DIR" "$NODE_DIR" "$TOOLS_DIR"
	rm -f "$BIN_DIR/oasis"
	say "Removed OASIS. Settings, logins and sessions in $OASIS_HOME/agent were kept; delete that folder to remove them too."
	exit 0
fi

# ---------------------------------------------------------------- platform
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
Linux) NODE_OS=linux ;;
Darwin) NODE_OS=darwin ;;
*) die "unsupported system $OS. On Windows, run in PowerShell: irm https://raw.githubusercontent.com/FAHTHIZ/Oasis-/main/install.ps1 | iex" ;;
esac
case "$ARCH" in
x86_64 | amd64) NODE_ARCH=x64 ;;
arm64 | aarch64) NODE_ARCH=arm64 ;;
*) die "unsupported CPU $ARCH" ;;
esac

download() { # url dest
	if have curl; then curl -fsSL --retry 3 "$1" -o "$2"; elif have wget; then wget -q "$1" -O "$2"; else die "curl or wget is required"; fi
}

# ---------------------------------------------------------------- git
if ! have git; then
	if [ "$NODE_OS" = darwin ]; then die "git is missing. Run: xcode-select --install, then re-run this installer."; fi
	die "git is missing. Install it with your package manager (e.g. sudo apt install git), then re-run this installer."
fi

# ---------------------------------------------------------------- Node.js
node_ok() { # path-to-node
	"$1" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>$NODE_MIN_MAJOR||(a===$NODE_MIN_MAJOR&&b>=$NODE_MIN_MINOR)?0:1)" 2>/dev/null
}
NODE_BIN=""
if [ -x "$NODE_DIR/bin/node" ] && node_ok "$NODE_DIR/bin/node"; then
	NODE_BIN="$NODE_DIR/bin/node"
elif have node && node_ok "$(command -v node)"; then
	NODE_BIN="$(command -v node)"
else
	say "Installing Node.js $NODE_VERSION for OASIS (private copy in $NODE_DIR)"
	TMP="$(mktemp -d)"
	trap 'rm -rf "$TMP"' EXIT
	NAME="node-v$NODE_VERSION-$NODE_OS-$NODE_ARCH"
	BASE="https://nodejs.org/dist/v$NODE_VERSION"
	download "$BASE/$NAME.tar.gz" "$TMP/node.tar.gz"
	download "$BASE/SHASUMS256.txt" "$TMP/SHASUMS256.txt"
	EXPECTED="$(grep " $NAME.tar.gz\$" "$TMP/SHASUMS256.txt" | awk '{print $1}')"
	if have sha256sum; then ACTUAL="$(sha256sum "$TMP/node.tar.gz" | awk '{print $1}')"; else ACTUAL="$(shasum -a 256 "$TMP/node.tar.gz" | awk '{print $1}')"; fi
	[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || die "Node.js download failed its checksum"
	rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
	tar -xzf "$TMP/node.tar.gz" -C "$NODE_DIR" --strip-components=1
	NODE_BIN="$NODE_DIR/bin/node"
fi
NODE_BIN_DIR="$(dirname "$NODE_BIN")"
export PATH="$NODE_BIN_DIR:$PATH"
NPM="$NODE_BIN_DIR/npm"
[ -x "$NPM" ] || NPM="npm"
printf '%s\n' "${D}    node $("$NODE_BIN" --version) at $NODE_BIN${N}"

# ---------------------------------------------------------------- OASIS
mkdir -p "$OASIS_HOME"
if [ -d "$APP_DIR/.git" ]; then
	say "Updating OASIS in $APP_DIR"
	git -C "$APP_DIR" fetch --quiet --depth 1 origin "$BRANCH"
	if [ -n "$(git -C "$APP_DIR" status --porcelain --untracked-files=no)" ]; then
		die "$APP_DIR has local changes; move them aside and re-run"
	fi
	git -C "$APP_DIR" checkout --quiet -B "$BRANCH" FETCH_HEAD
else
	say "Downloading OASIS ($BRANCH)"
	rm -rf "$APP_DIR"
	git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

say "Installing dependencies (this takes a minute)"
LOG="$OASIS_HOME/install.log"
ok=0
for attempt in 1 2 3; do
	if (cd "$APP_DIR" && "$NPM" ci --no-audit --no-fund --loglevel=error) >"$LOG" 2>&1; then ok=1; break; fi
	[ "$attempt" -lt 3 ] && warn "npm ci failed (attempt $attempt of 3); retrying"
done
[ "$ok" = "1" ] || { tail -20 "$LOG" >&2; die "npm ci failed; full log in $LOG"; }
say "Building"
(cd "$APP_DIR" && "$NPM" run build --silent) >"$LOG" 2>&1 || { tail -20 "$LOG" >&2; die "build failed; full log in $LOG"; }

# ---------------------------------------------------------------- optional tools
if [ "$WITH_TOOLS" = "1" ]; then
	say "Installing language servers into $TOOLS_DIR"
	mkdir -p "$TOOLS_DIR"
	"$NPM" install --prefix "$TOOLS_DIR" --global --no-audit --no-fund --loglevel=error \
		typescript typescript-language-server pyright bash-language-server yaml-language-server vscode-langservers-extracted >/dev/null ||
		warn "some language servers failed to install; OASIS works without them"
	if have go; then GOBIN="$TOOLS_DIR/bin" go install golang.org/x/tools/gopls@latest >/dev/null 2>&1 || warn "gopls failed to install"; fi
	if have rustup; then rustup component add rust-analyzer >/dev/null 2>&1 || warn "rust-analyzer failed to install"; fi
fi

# ---------------------------------------------------------------- launcher
mkdir -p "$BIN_DIR"
cat >"$BIN_DIR/oasis" <<LAUNCHER
#!/bin/sh
# Generated by the OASIS installer. Re-run the installer or \`oasis update\` to update.
PATH="$TOOLS_DIR/bin:$NODE_BIN_DIR:\$PATH"
export PATH
exec "$NODE_BIN" "$APP_DIR/bin/oasis.mjs" "\$@"
LAUNCHER
chmod +x "$BIN_DIR/oasis"

"$BIN_DIR/oasis" --version >/dev/null 2>&1 || die "installed, but \`oasis --version\` failed; run $BIN_DIR/oasis --version to see why"

# ---------------------------------------------------------------- PATH
case ":$PATH:" in
*":$BIN_DIR:"*) ON_PATH=1 ;;
*) ON_PATH=0 ;;
esac
if [ "$ON_PATH" = "0" ] && [ "$MODIFY_PATH" = "1" ]; then
	LINE="export PATH=\"$BIN_DIR:\$PATH\""
	case "${SHELL##*/}" in
	zsh) PROFILE="$HOME/.zshrc" ;;
	bash) if [ "$NODE_OS" = darwin ]; then PROFILE="$HOME/.bash_profile"; else PROFILE="$HOME/.bashrc"; fi ;;
	fish) PROFILE="$HOME/.config/fish/config.fish"; LINE="fish_add_path $BIN_DIR" ;;
	*) PROFILE="$HOME/.profile" ;;
	esac
	mkdir -p "$(dirname "$PROFILE")"
	if ! grep -qsF "$BIN_DIR" "$PROFILE"; then
		printf '\n# OASIS\n%s\n' "$LINE" >>"$PROFILE"
		printf '%s\n' "${D}    added $BIN_DIR to PATH in $PROFILE${N}"
	fi
fi

printf '\n%s\n' "${G}${B}OASIS $("$BIN_DIR/oasis" --version) is installed.${N}"
if [ "$ON_PATH" = "0" ]; then
	printf '%s\n' "Open a new terminal (or run: export PATH=\"$BIN_DIR:\$PATH\"), then:"
fi
printf '%s\n' "  cd your-project && oasis        start, then type /login to pick a provider"
printf '%s\n' "  oasis doctor                    check your setup"
printf '%s\n' "  oasis update                    update later"
