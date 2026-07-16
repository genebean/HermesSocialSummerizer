# NixOS module for social-reader.
#
# Supports two transport modes:
#
#   stdio (default)
#     A read-only MCP server with no open port and no long-running daemon.
#     The MCP host (Claude Code, Hermes, etc.) launches it as a subprocess on
#     demand. The module:
#       1. Writes a generated config.yaml to the Nix store (no secrets — only
#          ${ENV_VAR} placeholders the app resolves at runtime)
#       2. Creates a writable data directory for cursor state
#       3. Installs a wrapper binary that sets SOCIAL_READER_MCP_CONFIG and
#          CURSOR_STATE_PATH so the MCP host's command entry is just "social-reader-mcp"
#
#   http (services.social-reader-mcp.http.enable = true)
#     Adds a systemd service (social-reader-mcp-http) that starts the same binary
#     with SOCIAL_READER_MCP_TRANSPORT=http, binding a bearer-token-protected MCP
#     endpoint on the configured host:port. Useful for MCP hosts on other LAN
#     machines (other Hermes instances, Claude Code on a different box).
#
# Secrets (actual token values) are never in the Nix store. They come from the
# environment of the process — either the MCP host's systemd EnvironmentFile,
# the user's shell, Docker --env-file, or the http.environmentFile option.

self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.social-reader-mcp;

  # Build a config.yaml from module options. Credentials are represented as
  # ${ENV_VAR} placeholders; the app expands them from the environment at
  # startup. The resulting file is world-readable in the Nix store, which is
  # safe because it contains only account IDs, URLs, and variable *names*.
  generatedConfig = pkgs.writeText "social-reader-mcp-config.yaml" (
    lib.optionalString (cfg.mastodon != [ ]) (
      "mastodon:\n"
      + lib.concatMapStrings (
        a:
        "  - id: \""
        + a.id
        + "\"\n"
        + "    instance_url: \""
        + a.instanceUrl
        + "\"\n"
        + "    access_token: \"\${"
        + a.accessTokenEnv
        + "}\"\n"
      ) cfg.mastodon
    )
    + lib.optionalString (cfg.bluesky != [ ]) (
      "bluesky:\n"
      + lib.concatMapStrings (
        a:
        "  - id: \""
        + a.id
        + "\"\n"
        + "    handle: \""
        + a.handle
        + "\"\n"
        + lib.optionalString (a.appPasswordEnv != null) (
          "    app_password: \"\${" + a.appPasswordEnv + "}\"\n"
        )
      ) cfg.bluesky
    )
    + lib.optionalString (cfg.nostr != [ ]) (
      "nostr:\n"
      + lib.concatMapStrings (
        a:
        "  - id: \""
        + a.id
        + "\"\n"
        + "    npub: \""
        + a.npub
        + "\"\n"
        + "    relays:\n"
        + lib.concatMapStrings (r: "      - \"" + r + "\"\n") a.relays
      ) cfg.nostr
    )
  );

  # Wrapper that injects the two required path variables before exec-ing the
  # real binary. Everything else (secret env vars) must already be present
  # in the environment — set them in the MCP host's systemd EnvironmentFile
  # or equivalent.
  wrapper = pkgs.writeShellScriptBin "social-reader-mcp" ''
    export SOCIAL_READER_MCP_CONFIG="${cfg.configFile}"
    export CURSOR_STATE_PATH="${cfg.dataDir}/cursor_state.json"
    exec ${cfg.package}/bin/social-reader-mcp "$@"
  '';
in
{
  options.services.social-reader-mcp = {
    enable = lib.mkEnableOption "social-reader-mcp read-only social feed MCP server";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "self.packages.\${pkgs.stdenv.hostPlatform.system}.default";
      description = "The social-reader-mcp package to use.";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/social-reader-mcp";
      description = ''
        Directory for runtime state (cursor_state.json). Must be writable by
        whichever user runs the MCP host that launches social-reader.
        Set <option>services.social-reader-mcp.user</option> to ensure the
        directory is owned by the correct account.
      '';
    };

    user = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "gene";
      description = ''
        User that owns the data directory. Set this to the user account that
        runs your MCP host (Claude Code, Hermes, etc.). If null, the directory
        is created owned by root and you must manage permissions manually.
      '';
    };

    configFile = lib.mkOption {
      type = lib.types.path;
      default = generatedConfig;
      defaultText = lib.literalExpression "generated from mastodon/bluesky/nostr options";
      description = ''
        Path to config.yaml. Defaults to a file generated from the account
        options below. Override with an absolute path to bring your own config.
      '';
    };

    mastodon = lib.mkOption {
      type = lib.types.listOf (
        lib.types.submodule {
          options = {
            id = lib.mkOption {
              type = lib.types.str;
              example = "main";
              description = "Unique identifier used as account_id in MCP tool calls.";
            };
            instanceUrl = lib.mkOption {
              type = lib.types.str;
              example = "https://mastodon.social";
              description = "Mastodon instance base URL. Must use https://.";
            };
            accessTokenEnv = lib.mkOption {
              type = lib.types.str;
              example = "MASTODON_MAIN_TOKEN";
              description = ''
                Name of the environment variable holding the OAuth access token.
                The token must be scoped to read only at the instance level.
                The actual value is never stored in the Nix configuration.
              '';
            };
          };
        }
      );
      default = [ ];
      description = "Mastodon accounts to configure.";
      example = lib.literalExpression ''
        [{
          id = "main";
          instanceUrl = "https://mastodon.social";
          accessTokenEnv = "MASTODON_MAIN_TOKEN";
        }]
      '';
    };

    bluesky = lib.mkOption {
      type = lib.types.listOf (
        lib.types.submodule {
          options = {
            id = lib.mkOption {
              type = lib.types.str;
              example = "personal";
              description = "Unique identifier used as account_id in MCP tool calls.";
            };
            handle = lib.mkOption {
              type = lib.types.str;
              example = "example.bsky.social";
              description = "Bluesky handle.";
            };
            appPasswordEnv = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "BSKY_PERSONAL_APP_PW";
              description = ''
                Name of the environment variable holding the app password.
                If null, this account uses Bluesky's public unauthenticated
                AppView — no credentials are stored or required.
                Use a dedicated, revocable app password; not your main login.
              '';
            };
          };
        }
      );
      default = [ ];
      description = "Bluesky accounts to configure.";
    };

    nostr = lib.mkOption {
      type = lib.types.listOf (
        lib.types.submodule {
          options = {
            id = lib.mkOption {
              type = lib.types.str;
              example = "main";
              description = "Unique identifier used as account_id in MCP tool calls.";
            };
            npub = lib.mkOption {
              type = lib.types.str;
              example = "npub1...";
              description = ''
                Public key in npub1... bech32 format. This is the ONLY key
                that belongs here. Never put an nsec (private key) anywhere
                in your NixOS configuration.
              '';
            };
            relays = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              example = [
                "wss://relay.damus.io"
                "wss://nos.lol"
              ];
              description = "Relay WebSocket URLs. Must use wss://.";
            };
          };
        }
      );
      default = [ ];
      description = "Nostr accounts to configure. Only the public key (npub) is ever stored.";
    };

    http = {
      enable = lib.mkEnableOption "HTTP transport for social-reader-mcp (LAN-facing bearer-token-gated listener)";

      port = lib.mkOption {
        type = lib.types.port;
        default = 8787;
        description = "Port for the HTTP MCP listener.";
      };

      bindAddress = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.1";
        description = ''
          Address the HTTP listener binds to. The default (127.0.0.1) restricts
          access to the local machine. Setting this to a LAN-facing address
          (e.g. "192.168.1.10" or "0.0.0.0") exposes the server on the network.
          This is what makes the runtime no-token-on-non-loopback guard relevant:
          the server will refuse to start without a configured bearer token when
          bound to a non-loopback address.
        '';
      };

      tokenEnv = lib.mkOption {
        type = lib.types.str;
        default = "SOCIAL_READER_MCP_HTTP_TOKEN";
        example = "SOCIAL_READER_MCP_HTTP_TOKEN";
        description = ''
          Name of the environment variable that holds the bearer token used to
          authenticate HTTP requests. The actual token value is never stored in
          the Nix configuration — it must come from the process environment or
          from <option>services.social-reader-mcp.http.environmentFile</option>.

          This follows the same pattern as accessTokenEnv and appPasswordEnv:
          the option holds the variable *name*, not the secret itself.

          The server reads SOCIAL_READER_MCP_HTTP_TOKEN (literal value) or
          SOCIAL_READER_MCP_HTTP_TOKEN_FILE (path to a file containing the token)
          from the environment. Name your secret accordingly in environmentFile.
        '';
      };

      environmentFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        example = "/run/secrets/social-reader-mcp-http";
        description = ''
          Path to a file containing environment variable assignments injected
          into the social-reader-mcp-http systemd service. Intended for use with
          sops-nix or agenix to supply the bearer token and any platform
          credentials without embedding secrets in the Nix store or the unit.

          The file should define at least the bearer token — for example:
            SOCIAL_READER_MCP_HTTP_TOKEN=mysecrettoken
            MASTODON_MAIN_TOKEN=mymastodontoken

          Passed directly to the systemd unit as EnvironmentFile=.
        '';
      };
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.tmpfiles.rules =
      let
        owner = if cfg.user != null then cfg.user else "root";
      in
      [ "d ${cfg.dataDir} 0700 ${owner} - -" ];

    # The wrapper is installed system-wide. Point your MCP host at "social-reader-mcp"
    # and it will find it on PATH with SOCIAL_READER_MCP_CONFIG and CURSOR_STATE_PATH
    # already set. You still need to supply the secret env vars (token values)
    # via the MCP host's own environment or EnvironmentFile.
    environment.systemPackages = [ wrapper ];

    # HTTP transport systemd service — only created when http.enable = true.
    # Runs the same wrapper binary as stdio mode but with SOCIAL_READER_MCP_TRANSPORT=http
    # so it binds an HTTP listener instead of reading/writing stdio.
    #
    # Two process instances can coexist (one stdio, one HTTP) as long as they use
    # different cursor state files (CURSOR_STATE_PATH). Running two live consumers
    # against the same cursor file would race over the same per-account cursor.
    systemd.services.social-reader-mcp-http = lib.mkIf cfg.http.enable {
      description = "social-reader-mcp HTTP transport";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];

      environment = {
        # Tell the binary to bind an HTTP listener instead of using stdio.
        SOCIAL_READER_MCP_TRANSPORT = "http";
        SOCIAL_READER_MCP_HTTP_PORT = toString cfg.http.port;
        SOCIAL_READER_MCP_HTTP_HOST = cfg.http.bindAddress;
      };

      serviceConfig = {
        ExecStart = "${wrapper}/bin/social-reader-mcp";
        Restart = "on-failure";
      }
      # Run as the configured user when set — same account that owns dataDir.
      // lib.optionalAttrs (cfg.user != null) { User = cfg.user; }
      # Inject secrets (bearer token, platform credentials) from the secret file.
      // lib.optionalAttrs (cfg.http.environmentFile != null) {
        EnvironmentFile = cfg.http.environmentFile;
      };
    };
  };
}
