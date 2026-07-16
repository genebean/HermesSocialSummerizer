{
  pkgs,
  lib ? pkgs.lib,
}:
let
  social-reader-mcp = import ./social-reader-mcp.nix { inherit pkgs lib; };
in
{
  inherit social-reader-mcp;
  container = import ./container.nix {
    inherit pkgs lib;
    package = social-reader-mcp;
  };
}
