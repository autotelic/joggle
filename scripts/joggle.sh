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
  # doppler resolves the project from the WORKING DIRECTORY's doppler.yaml, and a
  # sibling repository's setup wins over the explicit --project/--config (and
  # over DOPPLER_PROJECT/DOPPLER_CONFIG). So fetch the one secret from the joggle
  # root, then run from the caller's directory: the analysed root, a relative
  # --cwd, and the report's paths all stay what the caller asked for.
  key=$(cd "$root" && doppler secrets get TYPESAFE_API_KEY --project "$project" --config "$config" --plain 2>/dev/null) || key=""
  if [ -n "$key" ]; then
    export TYPESAFE_API_KEY="$key"
    # shellcheck disable=SC2086
    exec node $conditions "$entry" "$@"
  fi
  # A doppler that cannot answer must not take the tool down with it: the run
  # degrades to unverified findings, which is what a missing key already means.
  echo "joggle: doppler could not supply TYPESAFE_API_KEY; running without the model" >&2
fi

# shellcheck disable=SC2086
exec node $conditions "$entry" "$@"
