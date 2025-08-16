# Obsidian server config (not vibecoded)
# make sure obsidian user has gid permissions to your notes
# make sure that you add your credentials to /var/lib/obsidian/xpra.pass (use agenix or sops if you like)

{ config, lib, pkgs, ... }:

let obsidianPkg = pkgs.obsidian; in {
  nixpkgs.config.allowUnfree = true; # obsidian is not opensource lmao

  users.users.obsidian = {
    isSystemUser = true;
    home = "/var/lib/obsidian";
    group = "obsidian";
  };
  users.groups.obsidian = {};

  environment.systemPackages = with pkgs; [
    xpra
    xpra-html5
    obsidianPkg
  ];

  # If you have a headless server with no X or Wayland, fonts are a must to include
  fonts = {
    packages = with pkgs; [
      noto-fonts
      noto-fonts-emoji
    ];
    fontconfig = {
      defaultFonts = {
        emoji = ["Noto Color Emoji"];
        sansSerif = ["Inter" "Noto Color Emoji"];
        serif = ["Noto Serif" "Noto Color Emoji"];
        monospace = ["JetBrains Mono" "Noto Color Emoji"];
      };
    };
  };

  systemd.tmpfiles.rules = [
    "d /var/lib/obsidian 0750 obsidian obsidian -"
    "d /var/lib/obsidian/.xdg 0700 obsidian obsidian -"
    "d /var/lib/obsidian/.xdg/xpra 0700 obsidian obsidian -"
    "f /var/lib/obsidian/xpra.pass 0640 obsidian obsidian -"
  ];

  services.dbus.enable = true; # Stops annoying Electron dbus errors under some circumstances (you might want to remove this)

  systemd.services.obsidian-server = {
    description = "Obsidian served in the browser";
    after = [ "network.target" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      User = "obsidian";
      Group = "obsidian";
      UMask = lib.mkForce "0007";
      WorkingDirectory = "/var/lib/obsidian";
      Restart = "always";
      ExecStart = ''
        ${pkgs.xpra}/bin/xpra start :100 \
          --bind-tcp=0.0.0.0:10000 \
          --html=on \
          --socket-dir=/var/lib/obsidian/.xdg/xpra \
          --start-child="${obsidianPkg}/bin/obsidian --disable-gpu --no-sandbox" \
          --exit-with-children=yes \
          --daemon=no \
          --auth=file:filename=/var/lib/obsidian/xpra.pass \
          --clipboard=yes \
          --resize-display=yes \
          --mdns=no --webcam=no --printing=no --pulseaudio=no
      '';
      Environment = [
        "XDG_RUNTIME_DIR=/var/lib/obsidian/.xdg"
        "XDG_CONFIG_HOME=/var/lib/obsidian/.config"
        "HOME=/var/lib/obsidian"
      ];
    };
  };

  networking.firewall.allowedTCPPorts = [ 10000 ];
}
