use crate::mihomo::config_gen::NameServerPolicy;

pub(crate) fn normalize_nameserver_policy(policy: &mut NameServerPolicy) -> bool {
    let normalized_servers = policy.normalized_servers();
    let primary_server = normalized_servers.first().cloned().unwrap_or_default();
    let mut changed = false;

    if policy.server != primary_server {
        policy.server = primary_server;
        changed = true;
    }
    if policy.servers != normalized_servers {
        policy.servers = normalized_servers;
        changed = true;
    }

    changed
}
