use super::*;
fn measured(route: &str, ms: [f64; 2]) -> RouteMeasurement {
    let mut r = RouteMeasurement::new(route);
    r.egress_ip = Some("192.0.2.1".into());
    for (i, t) in r.targets.iter_mut().enumerate() {
        t.response_ms = vec![ms[i], ms[i] * 0.98, ms[i] * 1.02];
    }
    r
}
#[test]
fn chooses_only_useful_complete_end_to_end_latency_gains() {
    let direct = measured("direct_exit", [500., 600.]);
    let faster = measured("chain", [350., 400.]);
    assert!(score(&[direct.clone(), faster.clone()]).unwrap().1);
    assert!(
        !score(&[direct.clone(), measured("chain", [510., 650.])])
            .unwrap()
            .1
    );
    assert!(
        !score(&[direct.clone(), measured("chain", [480., 580.])])
            .unwrap()
            .1
    );
    // A large improvement on GitHub cannot hide a YouTube regression.
    assert!(
        !score(&[direct.clone(), measured("chain", [600., 200.])])
            .unwrap()
            .1
    );
    let mut incomplete = faster.clone();
    incomplete.targets[0].response_ms.pop();
    assert!(score(&[direct.clone(), incomplete]).is_none());
    let mut failed = faster.clone();
    failed.targets[1].error = Some("HTTP 403".into());
    assert!(score(&[direct.clone(), failed]).is_none());
    let mut different = faster;
    different.egress_ip = Some("192.0.2.2".into());
    assert!(score(&[direct, different]).is_none());
}
#[test]
fn tiny_or_nonfinite_measurements_cannot_trigger_selection() {
    assert!(
        !score(&[
            measured("direct_exit", [50., 50.]),
            measured("chain", [40., 40.])
        ])
        .unwrap()
        .1
    );
    assert!(score(&[
        measured("direct_exit", [f64::NAN, 500.]),
        measured("chain", [200., 200.])
    ])
    .is_none());
}
fn candidate(name: &str, latency: f64, baseline: f64) -> Candidate {
    let reference = NodeRef::Subscription {
        subscription_id: "s".into(),
        proxy_name: name.into(),
    };
    let settings = ChainSettings {
        enabled: true,
        entry: Some(reference.clone()),
        exit: Some(NodeRef::Manual {
            node_id: "vps".into(),
        }),
    };
    Candidate {
        reference,
        name: name.into(),
        source: "s".into(),
        error: None,
        comparison: Some(build(
            settings,
            vec![
                measured("direct_exit", [baseline; 2]),
                measured("chain", [latency; 2]),
            ],
        )),
    }
}
#[test]
fn ranking_uses_chain_latency_and_never_applies_partial_or_cancelled_scans() {
    // Fastest absolute route wins, not the biggest percentage against a noisy baseline.
    let a = candidate("fast", 300., 500.);
    let b = candidate("larger_percentage", 400., 1000.);
    let chosen = decision(&[a.clone(), b], false);
    assert_eq!(chosen.0, "selected");
    assert_eq!(chosen.1, Some(a.reference.clone()));
    assert_eq!(
        decision(&[candidate("slow", 700., 500.)], false).0,
        "no_gain"
    );
    let mut partial = a.clone();
    partial.comparison = None;
    assert_eq!(decision(&[a.clone(), partial], false).0, "inconclusive");
    assert_eq!(decision(&[a], true).0, "cancelled");
}
