# Docker image built with pkgs.dockerTools.buildLayeredImage.
#
# The MCP server speaks stdio, so the container is run interactively with
# stdin/stdout connected to the MCP client. Example via Claude Code .mcp.json:
#
#   {
#     "mcpServers": {
#       "social-reader-mcp": {
#         "command": "docker",
#         "args": [
#           "run", "--rm", "-i",
#           "--env-file", "/path/to/.env",
#           "-e", "SOCIAL_READER_MCP_CONFIG=/config/config.yaml",
#           "-e", "CURSOR_STATE_PATH=/data/cursor_state.json",
#           "-v", "/path/to/config.yaml:/config/config.yaml:ro",
#           "-v", "/path/to/data:/data",
#           "social-reader-mcp:latest"
#         ]
#       }
#     }
#   }
#
# Required mounts / env at runtime:
#   /config/config.yaml   (SOCIAL_READER_MCP_CONFIG) — read-only config with ${ENV_VAR} refs
#   /data/                (CURSOR_STATE_PATH)     — writable volume for cursor_state.json
#   Secret env vars (MASTODON_*_TOKEN, BSKY_*_APP_PW, etc.) via --env-file or -e

{
  pkgs,
  lib,
  package,
}:

pkgs.dockerTools.buildLayeredImage {
  name = "social-reader-mcp";
  tag = "latest";

  contents = [
    package # the social-reader-mcp binary and Node runtime
    pkgs.cacert # CA certificates for HTTPS (Mastodon) and WSS (Nostr) connections
    pkgs.fakeNss # minimal /etc/passwd and /etc/group so Node.js uid lookups don't fail
  ];

  config = {
    Cmd = [ "${package}/bin/social-reader-mcp" ];

    Env = [
      # Make CA certificates available to OpenSSL-based tools in the container.
      # Node.js uses its own bundled cert store for TLS, so this mainly helps
      # if additional tooling is ever added to the image.
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      "NIX_SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      "NODE_ENV=production"
      # Callers must set these at runtime:
      # SOCIAL_READER_MCP_CONFIG=/config/config.yaml
      # CURSOR_STATE_PATH=/data/cursor_state.json
      # ... plus platform-specific secret env vars
    ];

    # Declare mount points. These are documentation only in buildLayeredImage;
    # the caller is responsible for providing the actual mounts.
    Volumes = {
      "/config" = { }; # mount your config.yaml here (read-only is fine)
      "/data" = { }; # writable; cursor_state.json is written here
    };
  };
}
