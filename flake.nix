{
  description = "opencode-to-openai dev shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };

        nodeModules = pkgs.stdenv.mkDerivation {
          pname = "opencode-to-openai-node-modules";
          version = "0.1.0";
          src = pkgs.lib.cleanSourceWith {
            filter =
              name: type:
              let
                baseName = baseNameOf name;
              in
              baseName == "package.json" || baseName == "bun.lock";
            src = ./.;
          };
          nativeBuildInputs = [ pkgs.bun ];
          buildPhase = ''
            export HOME=$TMPDIR
            bun install --frozen-lockfile --production
          '';
          installPhase = ''
            mkdir -p $out
            cp -r node_modules $out/node_modules
          '';
          outputHashAlgo = "sha256";
          outputHashMode = "recursive";
          outputHash = "sha256-2e1ZwFWnbiFCeNMkO0InJFzeZ48uZCbqTQpLAZBT25c=";
        };
      in
      {
        packages = rec {
          docker = pkgs.dockerTools.buildLayeredImage {
            name = "opencode-to-openai";
            tag = "latest";

            contents = [
              pkgs.bun
              pkgs.cacert
            ];

            extraCommands = ''
              mkdir -p app
              cp -r ${./.}/* app/
              cp -r ${nodeModules}/node_modules app/node_modules
            '';

            config = {
              Cmd = [
                "${pkgs.bun}/bin/bun"
                "run"
                "start"
              ];
              WorkingDir = "/app";
              ExposedPorts = {
                "8000/tcp" = { };
              };
              Env = [
                "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
              ];
            };
          };

          default = docker;
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            gcc
            typescript-language-server
          ];

          shellHook = ''
            export LD_LIBRARY_PATH="${pkgs.stdenv.cc.cc.lib}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
          '';
        };
      }
    );
}
