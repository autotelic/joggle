#!/usr/bin/env sh
# The `joggle` command, usable from any workspace.
#
# Symlink it onto PATH once:
#
#   ln -sf <repo>/scripts/joggle.sh ~/.local/bin/joggle
#
# It runs this checkout's build, and supplies the TypeSafe key through doppler
# when the environment does not already have one and the run needs the model.
# The project and config are passed explicitly, not inferred from the working
# directory, so a sibling repository's doppler.yaml cannot shadow them.
set -eu

# Resolve the symlink chain to the real script, then its repository.
src=$0
while [ -L "$src" ]; do
  dir=$(CDPATH= cd -- "$(dirname -- "$src")" && pwd)
  src=$(readlink "$src")
  case "$src" in
    /*) ;;
    *) src="$dir/$src" ;;
  esac
done
root=$(CDPATH= cd -- "$(dirname -- "$src")/.." && pwd)

if [ -f "$root/dist/main.js" ]; then
  entry="$root/dist/main.js"
  conditions=""
else
  entry="$root/src/main.ts"
  conditions="--conditions=development"
fi

# The judged layer is the only thing that needs the key. Everything else runs
# directly, so `rules`, help and `--offline` never pay doppler's startup.
needs_key=true
case "${1:-}" in
  rules | --help | -h | --version | -v | --completions | --wizard) needs_key=false ;;
esac
case " $* " in
  *" --offline "*) needs_key=false ;;
esac

if [ "$needs_key" = true ] && [ -z "${TYPESAFE_API_KEY:-}" ] && command -v doppler >/dev/null 2>&1; then
  project=${JOGGLE_DOPPLER_PROJECT:-joggle}
  config=${JOGGLE_DOPPLER_CONFIG:-dev}
  # shellcheck disable=SC2086
  exec doppler run --project "$project" --config "$config" -- node $conditions "$entry" "$@"
fi

# shellcheck disable=SC2086
exec node $conditions "$entry" "$@"
