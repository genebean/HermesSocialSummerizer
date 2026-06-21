# NixOS module for social-reader.
#
# This is a read-only MCP stdio server — it has no open port and no
# long-running daemon. The MCP host (Claude Code, Hermes, etc.) launches it
# as a subprocess on demand. The module's job is to:
#   1. Write a generated config.yaml to the Nix store (no secrets — only
#      ${ENV_VAR} placeholders that the app resolves at runtime)
#   2. Create a writable data directory for cursor state
#   3. Install a wrapper binary that sets SOCIAL_READER_CONFIG and
#      CURSOR_STATE_PATH, so the MCP host's command entry can be just
#      "social-reader" with no extra flags
#
# Secrets (actual token values) are never in the Nix store. They come from
# the environment of the process that launches social-reader — typically the
# MCP host's systemd EnvironmentFile, the user's shell environment, or
# Docker's --env-file.

self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.social-reader;

  # Build a config.yaml from module options. Credentials are represented as
  # ${ENV_VAR} placeholders; the app expands them from the environment at
  # startup. The resulting file is world-readable in the Nix store, which is
  # safe because it contains only account IDs, URLs, and variable *names*.
  generatedConfig = pkgs.writeText "social-reader-config.yaml" (
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
        + "    access_token: \"${" + a.accessTokenEnv + "}\"\n"
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
          "    app_password: \"${" + a.appPasswordEnv + "}\"\n"
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
  wrapper = pkgs.writeShellScriptBin "social-reader" ''
    export SOCIAL_READER_CONFIG="${cfg.configFile}"
    export CURSOR_STATE_PATH="${cfg.dataDir}/cursor_state.json"
    exec ${cfg.package}/bin/social-reader "$@"
  '';
in
{
  options.services.social-reader = {
    enable = lib.mkEnableOption "social-reader read-only social feed MCP server";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.system}.default;
      defaultText = lib.literalExpression "self.packages.\${pkgs.system}.default";
      description = "The social-reader package to use.";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/social-reader";
      description = ''
        Directory for runtime state (cursor_state.json). Must be writable by
        whichever user runs the MCP host that launches social-reader.
        Set <option>services.social-reader.user</option> to ensure the
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
  };

  config = lib.mkIf cfg.enable {
    systemd.tmpfiles.rules =
      let
        owner = if cfg.user != null then cfg.user else "root";
      in
      [ "d ${cfg.dataDir} 0700 ${owner} - -" ];

    # The wrapper is installed system-wide. Point your MCP host at "social-reader"
    # and it will find it on PATH with SOCIAL_READER_CONFIG and CURSOR_STATE_PATH
    # already set. You still need to supply the secret env vars (token values)
    # via the MCP host's own environment or EnvironmentFile.
    environment.systemPackages = [ wrapper ];
  };
}
