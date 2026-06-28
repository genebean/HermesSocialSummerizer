{
  description = "Read-only social feed MCP server for Mastodon, Bluesky, and Nostr";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  };

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      pkgsFor = system: nixpkgs.legacyPackages.${system};
      ourPkgs = system: import ./pkgs { pkgs = pkgsFor system; };
    in
    {
      packages = forAllSystems (
        system:
        let
          p = ourPkgs system;
        in
        {
          default = p.social-reader;
          container = p.container;
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_24
              deadnix # Nix dead-code linter
              nixfmt-tree # Nix formatter
              pre-commit # Git hook runner
            ];

            shellHook = ''
              # After changing package-lock.json, recompute the npmDepsHash:
              #   nix run nixpkgs#prefetch-npm-deps package-lock.json
              # Then update the hash in pkgs/social-reader.nix.

              if [[ "$-" == *i* ]]; then
                echo ""
                echo "social-reader dev shell (Node $(node --version))"
                echo "  npm install        install / update node_modules"
                echo "  npm run unit       CI-safe unit tests (no credentials needed)"
                echo "  npm test           run integration smoke tests (needs config.yaml + .env)"
                echo "  npm run typecheck  TypeScript type check"
                echo "  npm run build      compile src/ → dist/"
                echo "  npm start          start MCP server (stdio, normally launched by MCP host)"
                echo "  SOCIAL_READER_TRANSPORT=http npm start   start in HTTP transport mode"
                echo ""
                echo "  nix build          build production package"
                echo "  nix build .#container  build Docker image (load with: docker load < result)"
                echo ""
              fi
            '';
          };
        }
      );

      formatter = forAllSystems (system: (pkgsFor system).nixfmt-tree);

      nixosModules.default = import ./nix/module.nix self;

      nixosConfigurations.test = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        modules = [
          self.nixosModules.default
          {
            services.social-reader = {
              enable = true;
              user = "alice";
              mastodon = [
                {
                  id = "main";
                  instanceUrl = "https://mastodon.social";
                  accessTokenEnv = "MASTODON_MAIN_TOKEN";
                }
              ];
              bluesky = [
                {
                  id = "personal";
                  handle = "example.bsky.social";
                  appPasswordEnv = "BSKY_PERSONAL_APP_PW";
                }
              ];
              nostr = [
                {
                  id = "main";
                  npub = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
                  relays = [ "wss://relay.damus.io" ];
                }
              ];
            };
            # Minimal stubs required for NixOS evaluation — not a bootable system.
            fileSystems."/" = {
              device = "none";
              fsType = "tmpfs";
            };
            boot.loader.grub.enable = false;
            system.stateVersion = "26.05";
          }
        ];
      };
    };
}
