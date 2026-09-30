use super::*;

#[test]
fn quit_starts_once_pending_blocks_and_complete_allows_exit() {
    // The static is process-global, so this test serializes the states it
    // asserts about in one ordered sequence.
    assert!(begin_exit_if_idle(), "first quit must start shutdown");
    assert!(
        !begin_exit_if_idle(),
        "a second quit while pending must not start shutdown again"
    );
    assert_eq!(EXIT_STATE.load(Ordering::SeqCst), EXIT_SHUTTING);

    mark_exit_complete();
    assert_eq!(EXIT_STATE.load(Ordering::SeqCst), EXIT_COMPLETE);
    // No new shutdown can start after completion; exit proceeds normally.
    assert!(!begin_exit_if_idle());
}
