use super::*;
#[test]
fn unknown_settings_stay_private_and_runtime_secrets_never_persist() {
    let mesh: MeshSettings = serde_json::from_value(json!({})).unwrap();
    assert!(!mesh.enabled && !mesh.allow_inbound);
    let mut cfg = AppConfig::default_config();
    cfg.mesh_runtime = Some(MeshRoute { port: 43210, token: "runtime-only-secret".into() });
    let disk = serde_json::to_string(&cfg).unwrap();
    assert!(!disk.contains("runtime-only-secret") && !disk.contains("mesh_runtime"));
}
#[test]
fn mesh_route_precedes_private_and_public_rules_and_fails_closed() {
    let mut cfg = AppConfig::default_config();
    cfg.mesh.ipv4_cidr = "100.117.234.0/24".into(); cfg.mesh.enabled = true;
    let base = json!({"proxies":[],"rules":["IP-CIDR,100.64.0.0/10,DIRECT","MATCH,Public"]});
    let mut v = base.clone(); apply(&cfg,&mut v).unwrap();
    assert_eq!(v["rules"][0], "IP-CIDR,100.117.234.0/24,REJECT,no-resolve");
    cfg.mesh_runtime = Some(MeshRoute { port: 32100, token: "private-token".into() });
    let mut v = base.clone(); apply(&cfg,&mut v).unwrap();
    assert_eq!(v["rules"][0], "IP-CIDR,100.117.234.0/24,Pingu Mesh,no-resolve");
    assert_eq!(v["proxies"][0]["password"],"private-token");
    cfg.mesh.enabled = false; let mut v = base; apply(&cfg,&mut v).unwrap();
    assert_eq!(v["rules"][0], "IP-CIDR,100.117.234.0/24,REJECT,no-resolve");
    assert_eq!(v["proxies"].as_array().unwrap().len(),0);
    cfg.mesh.ipv4_cidr = "0.0.0.0/0".into(); assert!(apply(&cfg,&mut v).is_err());
    assert!(check_ports(&[22,9090]).is_err()); assert!(check_ports(&[22,3000]).is_ok());
}
