{
  pkgs,
  lib ? pkgs.lib,
}:
let
  social-reader = import ./social-reader.nix { inherit pkgs lib; };
in
{
  inherit social-reader;
  container = import ./container.nix {
    inherit pkgs lib;
    package = social-reader;
  };
}
