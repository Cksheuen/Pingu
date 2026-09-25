use super::*;

/// Fixed clock for deterministic, wall-clock-free tests.
#[derive(Clone, Copy)]
struct FixedDay(chrono::NaiveDate);
impl FixedDay {
    fn parse(s: &str) -> Self {
        Self(chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap())
    }
    fn advance(&mut self, days: i64) {
        self.0 += chrono::Duration::days(days);
    }
}
impl DaySource for FixedDay {
    fn today(&self) -> chrono::NaiveDate {
        self.0
    }
}

struct TempDir(PathBuf);
impl TempDir {
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp_dir() -> TempDir {
    let base = std::env::temp_dir().join(format!(
        "pingu-logtest-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&base).unwrap();
    TempDir(base)
}

fn read(dir: &Path, day: &str) -> String {
    std::fs::read_to_string(WriterState::path_for(dir, FixedDay::parse(day).0)).unwrap_or_default()
}

#[test]
fn format_entry_truncates_multibyte_content_without_panicking() {
    // Each Chinese char is 3 bytes and emoji 4; a naive byte cut would
    // land inside UTF-8 and panic in String::truncate.
    for chunk in ["x", "中", "😀", "日志🎉"] {
        let line = format_entry("t", "info", &chunk.repeat(100_000));
        assert!(line.len() <= MAX_LINE_BYTES, "{}", chunk);
        assert!(line.ends_with("...\n"));
    }
}

/// Spawn a local writer (temp dir, fixed clock) and return its sender.
fn spawn_local_writer(dir: &Path) -> (SyncSender<Message>, thread::JoinHandle<()>) {
    let (tx, rx) = mpsc::sync_channel::<Message>(QUEUE_CAPACITY);
    let writer_dir = dir.to_path_buf();
    let dropped = Arc::new(AtomicU64::new(0));
    let handle = thread::spawn(move || {
        run_writer(
            rx,
            writer_dir,
            FixedDay::parse("2026-01-15"),
            NoRetention,
            dropped,
        )
    });
    (tx, handle)
}

fn barrier(tx: &SyncSender<Message>) {
    // Capacity 1 mirrors the production flush_barrier ack channel.
    let (ack_tx, ack_rx) = mpsc::sync_channel::<()>(1);
    tx.try_send(Message::Barrier(ack_tx)).unwrap();
    ack_rx
        .recv_timeout(FLUSH_WAIT_TIMEOUT)
        .expect("barrier ack must arrive");
}

/// A slow trickle (one line at a time, below BATCH_CAPACITY) must still be
/// persisted around the periodic-flush deadline, proving the timer is not
/// reset by mere arrivals.
#[test]
fn periodic_flush_persists_continuous_low_rate_arrivals() {
    let dir = temp_dir();
    let (tx, handle) = spawn_local_writer(dir.path());

    // Send a few lines spaced well under the flush interval; none reaches
    // BATCH_CAPACITY, so only the timer can persist them.
    for i in 0..3 {
        tx.try_send(Message::Line(format_entry(
            "t",
            "info",
            &format!("trickle-{i}"),
        )))
        .unwrap();
        thread::sleep(Duration::from_millis(90));
    }

    // Wait just beyond one flush window (no barrier — that would force it).
    let path = WriterState::path_for(dir.path(), FixedDay::parse("2026-01-15").0);
    let deadline = Instant::now() + Duration::from_millis(800);
    let contents = loop {
        if let Ok(c) = std::fs::read_to_string(&path) {
            if c.contains("trickle-2") {
                break c;
            }
        }
        assert!(
            Instant::now() < deadline,
            "periodic flush never wrote trickle lines"
        );
        thread::sleep(Duration::from_millis(20));
    };
    for i in 0..3 {
        assert!(contents.contains(&format!("trickle-{i}")));
    }
    drop(tx);
    handle.join().unwrap();
}

/// Even when the caller only enters recv AFTER the writer has already
/// processed the barrier, the capacity-1 ack is retained and delivered
/// (no false 3s wait).
#[test]
fn barrier_ack_survives_caller_recving_late() {
    let dir = temp_dir();
    let (tx, handle) = spawn_local_writer(dir.path());

    let (ack_tx, ack_rx) = mpsc::sync_channel::<()>(1);
    tx.try_send(Message::Barrier(ack_tx)).unwrap();

    // Give the writer plenty of time to process + send the ack before this
    // caller ever waits on it.
    thread::sleep(Duration::from_millis(200));
    let start = Instant::now();
    assert!(ack_rx.recv_timeout(Duration::from_secs(1)).is_ok());
    // Ack was buffered, so it returns immediately rather than after a wait.
    assert!(
        start.elapsed() < Duration::from_millis(300),
        "buffered ack must not incur a multi-second wait"
    );

    barrier(&tx);
    drop(tx);
    handle.join().unwrap();
}

#[test]
fn dropped_lines_are_summarised_on_next_flush() {
    let dir = temp_dir();
    // Capacity-2 queue with a parked receiver reproduces producer drops;
    // then route through a real writer so the summary is written.
    let (tx, rx) = mpsc::sync_channel::<Message>(QUEUE_CAPACITY);
    let dropped = Arc::new(AtomicU64::new(0));
    let writer_dir = dir.path().to_path_buf();
    let dropped_for_writer = dropped.clone();
    let handle = thread::spawn(move || {
        run_writer(
            rx,
            writer_dir,
            FixedDay::parse("2026-01-15"),
            NoRetention,
            dropped_for_writer,
        )
    });
    let producer = LogWriter {
        tx,
        dropped: dropped.clone(),
    };
    // Simulate drops directly, then a normal line + barrier flush.
    producer.dropped.fetch_add(3, AtomicOrdering::SeqCst);
    producer.enqueue(format_entry("t", "info", "after-drops"));
    barrier(&producer.tx);

    let contents = read(dir.path(), "2026-01-15");
    assert!(contents.contains("dropped 3 line(s)"));
    assert!(contents.contains("after-drops"));
    assert_eq!(producer.take_dropped(), 0);
    drop(producer);
    handle.join().unwrap();
}

#[test]
fn write_batch_concatenates_appends_in_order_within_one_day() {
    let dir = temp_dir();
    let mut state = WriterState::new(dir.path().to_path_buf(), FixedDay::parse("2026-01-01").0);

    state.write_batch(
        &mut vec![
            format_entry("t1", "info", "one"),
            format_entry("t2", "warn", "two"),
        ],
        &FixedDay::parse("2026-01-01"),
        &NoRetention,
    );
    state.write_batch(
        &mut vec![format_entry("t3", "error", "three")],
        &FixedDay::parse("2026-01-01"),
        &NoRetention,
    );

    assert_eq!(
        read(dir.path(), "2026-01-01"),
        "[t1] [info] one\n[t2] [warn] two\n[t3] [error] three\n"
    );
}

#[test]
fn write_batch_recovers_after_transient_open_failure() {
    let dir = temp_dir();
    let day = FixedDay::parse("2026-01-01");

    // Real OS fixture: place a REGULAR FILE exactly where the log
    // directory must be. create_dir_all then fails and open() fails with
    // ENOTDIR (parent path is not a directory), so the first open yields
    // None — no manually forged state.
    let blocked = dir.path().join("logdir-is-a-file");
    std::fs::write(&blocked, b"i am a file").unwrap();

    let mut state = WriterState::new(blocked.clone(), day.0);
    assert!(
        state.file.is_none(),
        "open must fail against a file-path parent"
    );

    // First batch: open retried inside write_batch, still blocked -> the
    // line is dropped and the handle stays None (no busy loop).
    state.write_batch(
        &mut vec![format_entry("t", "info", "lost-batch")],
        &day,
        &NoRetention,
    );
    assert!(state.file.is_none());

    // Filesystem recovers: remove the blocking regular file and create the
    // directory at that same path. The next batch reopens once and persists,
    // rather than staying broken until the next rollover.
    std::fs::remove_file(&blocked).unwrap();
    std::fs::create_dir_all(&blocked).unwrap();
    state.write_batch(
        &mut vec![format_entry("t", "info", "recovered-batch")],
        &day,
        &NoRetention,
    );
    assert!(state.file.is_some());

    let recovered =
        std::fs::read_to_string(WriterState::path_for(&blocked, day.0)).unwrap_or_default();
    assert!(recovered.contains("recovered-batch"));
    assert!(!recovered.contains("lost-batch"));
}

#[test]
fn rollover_moves_writes_to_the_new_dated_file() {
    let dir = temp_dir();
    let mut clock = FixedDay::parse("2026-01-01");
    let mut state = WriterState::new(dir.path().to_path_buf(), clock.0);

    state.write_batch(
        &mut vec![format_entry("t", "info", "old-day")],
        &clock,
        &NoRetention,
    );
    clock.advance(1);
    state.write_batch(
        &mut vec![format_entry("t", "info", "new-day")],
        &clock,
        &NoRetention,
    );

    let old = read(dir.path(), "2026-01-01");
    let new = read(dir.path(), "2026-01-02");
    assert!(old.contains("old-day") && !old.contains("new-day"));
    assert!(new.contains("new-day") && !new.contains("old-day"));
}

#[test]
fn retention_removes_only_files_older_than_seven_days() {
    let dir = temp_dir();
    let today = FixedDay::parse("2026-02-20");
    for offset in [0i64, 3, 7, 8, 30] {
        let day = today.0 - chrono::Duration::days(offset);
        std::fs::write(WriterState::path_for(dir.path(), day), b"x").unwrap();
    }
    std::fs::write(dir.path().join("unrelated.txt"), b"x").unwrap();

    cleanup_old_logs_in(dir.path(), &today);

    let mut names: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    assert_eq!(
        names,
        vec![
            "sing-proxy-2026-02-13.log".to_string(), // today - 7, kept
            "sing-proxy-2026-02-17.log".to_string(), // today - 3, kept
            "sing-proxy-2026-02-20.log".to_string(), // today, kept
            "unrelated.txt".to_string(),
        ]
    );
}

/// Drive a real writer thread through a local bounded channel against a
/// temp dir: barrier ack must guarantee prior lines are durable, with no
/// involvement from the production global writer or user log directory.
#[test]
fn local_writer_persists_queued_lines_and_barrier_flushes() {
    let dir = temp_dir();
    let (tx, handle) = spawn_local_writer(dir.path());

    tx.try_send(Message::Line(format_entry(
        "2026-01-15 12:00:00",
        "info",
        "local-marker-A",
    )))
    .unwrap();
    tx.try_send(Message::Line(format_entry(
        "2026-01-15 12:00:01",
        "warn",
        "local-marker-B",
    )))
    .unwrap();

    barrier(&tx);

    let contents = read(dir.path(), "2026-01-15");
    assert!(contents.contains("local-marker-A"));
    assert!(contents.contains("local-marker-B"));
    drop(tx);
    handle.join().unwrap();
}

#[test]
fn full_queue_drops_and_counts_instead_of_blocking() {
    // A receiver that parks without consuming saturates the bounded queue;
    // enqueue must then drop and count, never block.
    let (tx, rx) = mpsc::sync_channel::<Message>(2);
    let parked = thread::spawn(move || {
        thread::sleep(Duration::from_millis(300));
        let _ = rx.recv();
    });
    let writer = LogWriter {
        tx,
        dropped: Arc::new(AtomicU64::new(0)),
    };
    // Capacity 2: first two fit; subsequent ones drop rather than block.
    writer.enqueue("a\n".to_string());
    writer.enqueue("b\n".to_string());
    writer.enqueue("c\n".to_string());
    assert_eq!(writer.take_dropped(), 1);
    assert_eq!(writer.take_dropped(), 0);
    parked.join().unwrap();
}
