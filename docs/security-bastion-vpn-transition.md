# SSH Bastion/VPN Transition (No-Downtime)

## Goal
Move SSH access from public internet exposure to private access (Bastion/VPN),
without breaking VS Code Remote-SSH or Codex workflows.

## Current Safe Baseline
- `PermitRootLogin no`
- `PasswordAuthentication no`
- key-only auth
- SSH allowlisted in UFW (admin IP only)

## Rollout Plan
1. Create private access path
- Option A: Bastion host (recommended for teams)
- Option B: VPN (WireGuard/Tailscale)

2. Add private-path SSH allow rule first (do not remove current rule yet)
- Example (WireGuard subnet): `ufw allow from 10.66.0.0/24 to any port 22 proto tcp`

3. Test from VS Code Remote-SSH through Bastion/VPN
- Confirm connect/disconnect cycles work
- Confirm git pull/push and terminal commands work

4. Keep fallback window (24-48h)
- Keep existing admin IP allowlist during soak period

5. Final cutover
- Remove public SSH allowlist rule(s)
- Keep only Bastion/VPN source(s)

6. Post-cutover validation
- `sshd -t`
- `systemctl reload ssh`
- `ufw status numbered`
- verify login from Bastion/VPN path only

## Rollback
If access fails, restore prior UFW SSH allowlist rule from console/provider panel.

## Applied On This Server (2026-04-26 UTC)
- WireGuard package installed and enabled.
- Server interface: `wg0`
- Server VPN address: `10.66.0.1/24`
- Server UDP port: `51820`
- UFW rules added:
  - `51820/udp` allow (WireGuard)
  - `22/tcp` allow from `10.66.0.0/24` (SSH over VPN)
- Existing SSH admin IP rule kept as fallback:
  - `22/tcp` allow from `89.6.168.104`
- Client profile generated at:
  - `/root/wg-client-minhoo-admin.conf`

## Safe Next Step
1. Import `/root/wg-client-minhoo-admin.conf` into your WireGuard app.
2. Connect VPN from your laptop.
3. Confirm SSH works over VPN:
   - `ssh root@10.66.0.1`
4. Confirm VS Code Remote-SSH works over `10.66.0.1`.
5. Keep fallback IP rule for at least 24h.

## Final Cutover (after successful VPN tests)
Remove only the public admin IP SSH rule and keep VPN-only SSH:
- check rule numbers:
  - `sudo ufw status numbered`
- delete old admin IP rule (example number):
  - `sudo ufw delete <number_of_22_from_89.6.168.104>`
- validate:
  - `sudo ufw status numbered`
  - `sudo sshd -t && sudo systemctl reload ssh`

## Cutover Status (2026-04-26 UTC)
- Final SSH cutover executed.
- Public SSH admin-IP rule removed.
- SSH now allowed only from VPN subnet `10.66.0.0/24`.
