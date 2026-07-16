{ pkgs, lib }:

pkgs.buildNpmPackage {
  pname = "social-reader-mcp";
  version = "2.0.0";

  src = lib.cleanSourceWith {
    src = ../.;
    filter =
      path: type:
      let
        baseName = baseNameOf path;
      in
      lib.cleanSourceFilter path type
      && baseName != "config.yaml"
      && baseName != "cursor_state.json"
      # Exclude files that are only needed at runtime or in dev, not for the build
      && !(lib.hasSuffix ".env" baseName);
  };

  nodejs = pkgs.nodejs_24;

  # Recompute after package-lock.json changes:
  #   nix run nixpkgs#prefetch-npm-deps package-lock.json
  npmDepsHash = "sha256-kaZmBUP3+ZDtYL344hlW7fNj7WdBx7QoE91Alt8Z2HU=";

  # Runs `tsc` via the build script in package.json, emitting to dist/
  npmBuildScript = "build";

  nativeBuildInputs = [ pkgs.makeWrapper ];

  installPhase = ''
    runHook preInstall

    # Strip dev-only packages (typescript, tsx, @types/*) before copying.
    # npm prune is safe here — it only deletes directories, no network needed.
    npm prune --omit=dev --ignore-scripts

    mkdir -p $out/lib $out/bin

    # node_modules must sit alongside dist/ and package.json so Node's ESM
    # resolver finds imports when walking up from $out/lib/dist/*.js
    cp -r dist node_modules package.json $out/lib/

    # The wrapper sets NODE_ENV; runtime paths (SOCIAL_READER_MCP_CONFIG,
    # CURSOR_STATE_PATH) are left to the caller so the binary works equally
    # well when launched by a NixOS module wrapper, Docker, or directly.
    makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/social-reader-mcp \
      --add-flags "$out/lib/dist/server.js" \
      --set NODE_ENV production

    runHook postInstall
  '';

  meta = with lib; {
    description = "Read-only social feed MCP server for Mastodon, Bluesky, and Nostr";
    license = licenses.isc;
    platforms = platforms.linux;
    mainProgram = "social-reader-mcp";
  };
}
