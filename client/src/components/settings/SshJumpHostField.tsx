import { Alert, Autocomplete, Box, CircularProgress, Stack, TextField, Typography } from '@mui/material';
import type { SshConfigHost } from '@kubus/shared';
import { useSshInfo } from '../../api/queries.js';

/** Mirrors the server-side check: an ssh config alias, user@host or ssh://user@host:port — nothing option-like. */
export const SSH_DESTINATION_RE = /^(ssh:\/\/)?[A-Za-z0-9][A-Za-z0-9._~%@:\[\]-]*$/;

function sshUnavailableHint(platform: string): string {
  if (platform === 'win32') return 'Install it via Settings → System → Optional features → "OpenSSH Client", then restart Kubus.';
  if (platform === 'darwin') return 'macOS ships it at /usr/bin/ssh — check that it hasn’t been removed by device management.';
  return 'Install your distribution’s OpenSSH client package (e.g. "sudo apt install openssh-client").';
}

/**
 * Jump-host picker for Kubus-managed SSH tunnels: offers Host entries from the
 * user's ~/.ssh/config, accepts free-text destinations, and explains the
 * non-interactive-auth requirement. Shared by the Add and Edit cluster dialogs.
 */
export function SshJumpHostField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const sshInfo = useSshInfo();
  const valid = SSH_DESTINATION_RE.test(value.trim());

  return (
    <Stack spacing={1}>
      {sshInfo.isLoading && (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <CircularProgress size={14} />
          <Typography variant="caption" color="text.secondary">
            Checking SSH setup…
          </Typography>
        </Stack>
      )}
      {sshInfo.data && !sshInfo.data.sshAvailable && (
        <Alert severity="error">No SSH client found on this machine. {sshUnavailableHint(sshInfo.data.platform)}</Alert>
      )}
      {sshInfo.data?.parseError && (
        <Alert severity="warning" sx={{ py: 0 }}>
          Problem reading your SSH config: {sshInfo.data.parseError}
        </Alert>
      )}
      <Autocomplete
        freeSolo
        size="small"
        options={sshInfo.data?.hosts ?? []}
        getOptionLabel={(o) => (typeof o === 'string' ? o : o.alias)}
        renderOption={({ key: _key, ...optionProps }, o) => {
          const host = o as SshConfigHost;
          const detail = [host.user && host.hostname ? `${host.user}@${host.hostname}` : host.hostname ?? '', host.port ? `port ${host.port}` : '']
            .filter(Boolean)
            .join(' · ');
          return (
            <Box component="li" key={host.alias} {...optionProps} sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start !important' }}>
              <span>{host.alias}</span>
              {detail && (
                <Typography variant="caption" color="text.secondary">
                  {detail}
                </Typography>
              )}
            </Box>
          );
        }}
        inputValue={value}
        onInputChange={(_, v) => onChange(v)}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Jump host"
            placeholder="bastion or user@bastion.example.com"
            error={!!value.trim() && !valid}
            helperText={
              !sshInfo.data
                ? undefined
                : !sshInfo.data.configExists
                  ? `No SSH config found (${sshInfo.data.configPath}) — that's fine: type a destination like user@bastion.example.com`
                  : sshInfo.data.hosts.length
                    ? `Pick a Host from ${sshInfo.data.configPath} or type user@host`
                    : `No usable Host entries in ${sshInfo.data.configPath} — type a destination like user@bastion.example.com`
            }
          />
        )}
      />
      <Typography variant="caption" color="text.secondary">
        Kubus keeps an SSH tunnel (<code>ssh -N -D</code>) to this host running and routes the cluster&apos;s traffic through it. Your SSH config,
        keys, agent and ProxyJump chains apply. Connecting must work without prompts — if <code>ssh {value.trim() || '<host>'}</code> asks for a
        password in a terminal, load your key into ssh-agent first. Stored in Kubus settings; your kubeconfig stays kubectl-compatible.
      </Typography>
    </Stack>
  );
}
