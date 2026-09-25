use super::*;
use std::io::Write;
use std::net::{TcpListener, TcpStream};

/// Minimal scripted HTTP/1.1 server: reads one request, then the closure
/// writes whatever response body it likes (framing handled by the test
/// closure; ureq transparently decodes chunked framing when used).
struct FixtureServer {
    listener: TcpListener,
    port: u16,
}

impl FixtureServer {
    fn bind() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        Self { listener, port }
    }

    fn accept(&self) -> std::io::Result<TcpStream> {
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    break Ok(stream);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => break Err(error),
            }
        }
    }

    /// Read one HTTP/1.1 request and fully drain its headers. Returns the
    /// request path together with the accepted stream.
    fn accept_request(&self) -> std::io::Result<(String, TcpStream)> {
        use std::io::BufRead;
        let stream = self.accept()?;
        stream.set_read_timeout(Some(Duration::from_secs(3)))?;
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut line = Vec::new();
        reader.read_until(b'\n', &mut line)?;
        let request = String::from_utf8_lossy(&line).to_string();
        let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
        loop {
            line.clear();
            let read = reader.read_until(b'\n', &mut line)?;
            if read == 0 || line == b"\n" || line == b"\r\n" {
                break;
            }
        }
        Ok((path, stream))
    }

    /// Serve background connections: finite `/connections` JSON polls are
    /// answered immediately; the next `/traffic` request gets the 200
    /// chunked headers and the stream is returned for a scripted body.
    fn serve(&self) -> std::io::Result<TcpStream> {
        loop {
            let (path, mut stream) = self.accept_request()?;
            if path == "/connections" {
                let body = r#"{"uploadTotal":4096,"downloadTotal":8192,"connections":[]}"#;
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )?;
                stream.flush()?;
                // Closed by the response; keep accepting until /traffic.
                continue;
            }
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n")?;
            return Ok(stream);
        }
    }

    fn write_chunk(stream: &mut TcpStream, body: &str) {
        write!(stream, "{:x}\r\n{}\r\n", body.len(), body).unwrap();
        stream.flush().unwrap();
    }
}

fn wait_for<F>(mut predicate: F)
where
    F: FnMut() -> bool,
{
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if predicate() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("condition was not met before deadline");
}

#[test]
fn first_record_after_500ms_is_published_without_waiting_for_eof() {
    let server = FixtureServer::bind();
    let port = server.port;
    let monitor = TrafficMonitor::new();

    let server_thread = std::thread::spawn(move || {
        let mut stream = server.serve().unwrap();
        // Later than the old 500ms timeout; the reader must keep waiting.
        std::thread::sleep(Duration::from_millis(750));
        FixtureServer::write_chunk(&mut stream, "{\"up\":101,\"down\":202}\n");
        // Hold the connection open with zero-length chunk delays:
        // publishing must not depend on EOF.
        std::thread::sleep(Duration::from_secs(3));
    });

    monitor.attach(7, port);
    wait_for(|| {
        let sample = monitor.snapshot(7);
        sample.upload_speed == 101 && sample.download_speed == 202
    });
    monitor.detach();
    server_thread.join().unwrap();
}

#[test]
fn multiple_records_replace_the_cached_sample() {
    let server = FixtureServer::bind();
    let port = server.port;
    let monitor = TrafficMonitor::new();

    let server_thread = std::thread::spawn(move || {
        let mut stream = server.serve().unwrap();
        for (up, down) in [(1u64, 2u64), (30, 40), (300, 400)] {
            FixtureServer::write_chunk(&mut stream, &format!("{{\"up\":{up},\"down\":{down}}}\n"));
            std::thread::sleep(Duration::from_millis(30));
        }
        std::thread::sleep(Duration::from_secs(1));
    });

    monitor.attach(11, port);
    wait_for(|| {
        let sample = monitor.snapshot(11);
        sample.upload_speed == 300 && sample.download_speed == 400
    });
    monitor.detach();
    server_thread.join().unwrap();
}

#[test]
fn malformed_rows_are_ignored_without_overwriting_a_good_sample() {
    let server = FixtureServer::bind();
    let port = server.port;
    let monitor = TrafficMonitor::new();

    let server_thread = std::thread::spawn(move || {
        let mut stream = server.serve().unwrap();
        FixtureServer::write_chunk(&mut stream, "{\"up\":7,\"down\":9}\n");
        FixtureServer::write_chunk(&mut stream, "not-json-at-all\n");
        stream.flush().unwrap();
        std::thread::sleep(Duration::from_secs(1));
    });

    monitor.attach(13, port);
    wait_for(|| {
        let sample = monitor.snapshot(13);
        sample.upload_speed == 7 && sample.download_speed == 9
    });
    std::thread::sleep(Duration::from_millis(150));
    let sample = monitor.snapshot(13);
    assert_eq!((sample.upload_speed, sample.download_speed), (7, 9));
    monitor.detach();
    server_thread.join().unwrap();
}

#[test]
fn overlong_lines_are_discarded_and_parsing_realigns() {
    let server = FixtureServer::bind();
    let port = server.port;
    let monitor = TrafficMonitor::new();

    let server_thread = std::thread::spawn(move || {
        let mut stream = server.serve().unwrap();
        // One oversized chunk carrying a single huge line, then a normal
        // chunk with a valid record.
        let garbage = format!("{}\n", "x".repeat(MAX_LINE_BYTES + 4_096));
        FixtureServer::write_chunk(&mut stream, &garbage);
        FixtureServer::write_chunk(&mut stream, "{\"up\":5,\"down\":6}\n");
        std::thread::sleep(Duration::from_secs(2));
    });

    monitor.attach(17, port);
    wait_for(|| {
        let sample = monitor.snapshot(17);
        sample.upload_speed == 5 && sample.download_speed == 6
    });
    monitor.detach();
    server_thread.join().unwrap();
}

#[test]
fn reader_reconnects_after_eof_and_publishes_again() {
    let server = Arc::new(FixtureServer::bind());
    let port = server.port;
    let monitor = TrafficMonitor::new();

    let server_for_thread = Arc::clone(&server);
    let server_thread = std::thread::spawn(move || {
        // First connection: one chunk then terminating chunk + EOF.
        {
            let mut stream = server_for_thread.serve().unwrap();
            FixtureServer::write_chunk(&mut stream, "{\"up\":1,\"down\":1}\n");
            stream.write_all(b"0\r\n\r\n").unwrap();
            stream.flush().unwrap();
        }
        // Second connection (after reader backoff): keep serving.
        let mut stream = server_for_thread.serve().unwrap();
        FixtureServer::write_chunk(&mut stream, "{\"up\":22,\"down\":33}\n");
        std::thread::sleep(Duration::from_secs(1));
    });

    monitor.attach(19, port);
    wait_for(|| {
        let sample = monitor.snapshot(19);
        sample.upload_speed == 22 && sample.download_speed == 33
    });
    monitor.detach();
    server_thread.join().unwrap();
}

#[test]
fn stale_generation_is_suppressed_and_detach_resets_sample() {
    let monitor = TrafficMonitor::new();
    monitor.active_generation.store(21, Ordering::SeqCst);
    if let Ok(mut cached) = monitor.sample.lock() {
        *cached = CachedSample {
            generation: 21,
            upload_speed: 999,
            download_speed: 999,
            speeds_at: Some(Instant::now()),
            upload_total: 999,
            download_total: 999,
            totals_at: Some(Instant::now()),
        };
    }
    // Cache belongs to generation 21 but the runtime moved to 22.
    assert_eq!(monitor.snapshot(22), TrafficSample::default());
    // Detached runtimes always read zeros; production detach resets the
    // cached generation to 0 as well.
    monitor.reset_sample(0);
    assert_eq!(monitor.snapshot(21), TrafficSample::default());
}

#[test]
fn stale_speeds_decay_to_zero_while_totals_remain() {
    let monitor = TrafficMonitor::new();
    monitor.active_generation.store(31, Ordering::SeqCst);
    if let Ok(mut cached) = monitor.sample.lock() {
        *cached = CachedSample {
            generation: 31,
            upload_speed: 120,
            download_speed: 240,
            speeds_at: Some(Instant::now() - SPEED_FRESHNESS - Duration::from_millis(50)),
            upload_total: 5_000,
            download_total: 9_000,
            totals_at: Some(Instant::now()),
        };
    }
    let sample = monitor.snapshot(31);
    assert_eq!(sample.upload_speed, 0);
    assert_eq!(sample.download_speed, 0);
    assert_eq!(sample.upload_total, 5_000);
    assert_eq!(sample.download_total, 9_000);
}

#[test]
fn parser_concatenates_partial_buffers_until_newline() {
    // A synthetic reader that surfaces a record across multiple reads.
    struct Scripted {
        chunks: Vec<Vec<u8>>,
        index: usize,
    }
    impl Read for Scripted {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.index >= self.chunks.len() {
                return Ok(0);
            }
            let chunk = &self.chunks[self.index];
            self.index += 1;
            let len = chunk.len().min(buf.len());
            buf[..len].copy_from_slice(&chunk[..len]);
            Ok(len)
        }
    }

    let mut scripted = Scripted {
        chunks: vec![
            b"{\"up\":1,".to_vec(),
            b"\"down\":2}\r\n{\"up\":3,".to_vec(),
            b"\"down\":4}\n".to_vec(),
        ],
        index: 0,
    };
    let mut reader = LineReader::new();
    let mut body = LineReader::wrap(&mut scripted);

    let first = reader.read_line(&mut body).unwrap();
    assert_eq!(String::from_utf8(first).unwrap(), "{\"up\":1,\"down\":2}");
    let second = reader.read_line(&mut body).unwrap();
    assert_eq!(String::from_utf8(second).unwrap(), "{\"up\":3,\"down\":4}");
    assert_eq!(reader.read_line(&mut body), Err(LineError::Closed));
}

#[test]
fn timeout_mid_chunk_drops_response_and_reconnects_fresh() {
    // The first connection sends a truncated chunk body and then goes
    // silent past READ_TIMEOUT. ureq cannot resume that response, so the
    // reader must drop it and, after bounded backoff, publish from a
    // second, complete connection instead.
    let server = Arc::new(FixtureServer::bind());
    let port = server.port;
    let monitor = TrafficMonitor::new();

    let server_for_thread = Arc::clone(&server);
    let server_thread = std::thread::spawn(move || {
        {
            let mut stream = server_for_thread.serve().unwrap();
            // Declare a 20-byte chunk but deliver only a fragment.
            stream.write_all(b"14\r\n{\"up\":1,\"dow").unwrap();
            stream.flush().unwrap();
            // Stay silent long enough for READ_TIMEOUT (2s) to fire.
            std::thread::sleep(Duration::from_millis(2_600));
        }
        let mut stream = server_for_thread.serve().unwrap();
        FixtureServer::write_chunk(&mut stream, "{\"up\":71,\"down\":72}\n");
        std::thread::sleep(Duration::from_secs(1));
    });

    monitor.attach(71, port);
    wait_for(|| {
        let sample = monitor.snapshot(71);
        sample.upload_speed == 71 && sample.download_speed == 72
    });
    monitor.detach();
    server_thread.join().unwrap();
}

#[test]
fn rapid_reattach_cancels_old_reader_and_publishes_new_generation() {
    let first_server = FixtureServer::bind();
    let first_port = first_server.port;
    let second_server = FixtureServer::bind();
    let second_port = second_server.port;

    let monitor = Arc::new(TrafficMonitor::new());
    monitor.attach(61, first_port);
    // Immediate hot swap, before the first reader necessarily connected.
    monitor.attach(62, second_port);
    assert_eq!(monitor.active_generation.load(Ordering::SeqCst), 62);
    assert_eq!(monitor.snapshot(61), TrafficSample::default());

    let second_thread = std::thread::spawn(move || {
        let mut stream = second_server.serve().unwrap();
        FixtureServer::write_chunk(&mut stream, "{\"up\":62,\"down\":63}\n");
        std::thread::sleep(Duration::from_millis(800));
    });
    // The old connection may already be queued by the OS before cancellation.
    // Assert the observable generation below, not scheduler-dependent backlog.

    wait_for(|| {
        let sample = monitor.snapshot(62);
        sample.upload_speed == 62 && sample.download_speed == 63
    });
    assert_eq!(monitor.snapshot(61), TrafficSample::default());
    monitor.detach();
    second_thread.join().unwrap();
}

#[test]
fn traffic_record_parser_is_selective() {
    assert_eq!(
        parse_traffic_record("{\"up\":10,\"down\":20}"),
        Some((10, 20))
    );
    assert_eq!(parse_traffic_record(""), None);
    assert_eq!(parse_traffic_record("42"), None);
    assert_eq!(parse_traffic_record("{\"up\":10}"), None);
    assert_eq!(parse_traffic_record("garbage"), None);
}
