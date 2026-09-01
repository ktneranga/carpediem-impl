# Firewall Prerequisite — Vendor Support Ports

**This is a mandatory step during restaurant provisioning. Skipping it exposes full container control to anyone on the restaurant's local network.**

## Why this exists

Portainer (`:9000`) and Uptime Kuma (`:3001`) are vendor support tools. They must be reachable from Tailscale peers so the vendor can restart containers, read logs, and monitor health remotely without SSH (FR-V3, FR-V5, FR-V6, NFR-V1).

Tailscale traffic arrives on the `tailscale0` interface, **not** on loopback. Binding these ports to `127.0.0.1` therefore blocks Tailscale peers along with everyone else — the tools become reachable only from the server's own console, which defeats their purpose.

They are bound to all interfaces instead. The host firewall is what restricts access.

**Without the rules below, any device on the restaurant Wi-Fi — staff phones, guest devices, anyone who walks in and connects — can open Portainer and start, stop, or delete every container running the POS.**

## Required rules

Run on the restaurant server after Tailscale is installed and joined to the tailnet, and before handing the system over.

### ufw (Ubuntu / Debian)

```bash
# Allow vendor support tools ONLY from the Tailscale interface
sudo ufw allow in on tailscale0 to any port 9000 proto tcp
sudo ufw allow in on tailscale0 to any port 3001 proto tcp

# Explicitly deny them from every other interface
sudo ufw deny 9000/tcp
sudo ufw deny 3001/tcp

# The POS app itself stays open on the LAN — staff devices need it
sudo ufw allow 3000/tcp

sudo ufw enable
sudo ufw status verbose
```

Rule order matters in ufw: the interface-specific `allow` must be added before the blanket `deny`. Verify with `ufw status verbose` that the `tailscale0` rules appear above the deny rules.

### firewalld (RHEL / Fedora / Rocky)

```bash
sudo firewall-cmd --permanent --zone=trusted --change-interface=tailscale0
sudo firewall-cmd --permanent --zone=trusted --add-port=9000/tcp
sudo firewall-cmd --permanent --zone=trusted --add-port=3001/tcp
sudo firewall-cmd --permanent --zone=public --add-port=3000/tcp
sudo firewall-cmd --reload
```

## Verification — do not skip

From a device on the restaurant LAN that is **not** on the tailnet:

```bash
curl -m 5 http://<server-lan-ip>:9000   # MUST fail (refused or timeout)
curl -m 5 http://<server-lan-ip>:3001   # MUST fail
curl -m 5 http://<server-lan-ip>:3000   # MUST succeed — this is the POS
```

From a device on the tailnet:

```bash
curl -m 5 http://<server-tailscale-ip>:9000   # MUST succeed
curl -m 5 http://<server-tailscale-ip>:3001   # MUST succeed
```

If the first two succeed from the LAN, the firewall is not configured. Stop and fix before go-live.

## Defence in depth

The firewall is the primary control. Two more layers:

1. **Tailscale ACLs** — restrict which tailnet users can reach these ports, so a compromised personal device does not grant fleet-wide container control.
2. **Portainer admin password** — set on first visit. Set it immediately during provisioning; an uninitialised Portainer hands admin to whoever reaches it first.

## Alternative considered

Binding directly to the Tailscale IP (`${TAILSCALE_IP}:9000:9000`) removes the need for a firewall rule and fails closed rather than open. It was not adopted for v1 because it requires Tailscale to be up before Docker starts and the IP to be pinned per deployment. Revisit if provisioning errors occur in the field.
