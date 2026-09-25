//! Plain-text HTTPS subscription import.
//!
//! The web console serves subscriptions that contain exactly one VLESS device
//! node. This module deliberately stays narrow: it fetches one HTTPS URL,
//! enforces a small response bound, and accepts a body containing exactly one
//! `vless://` line. Error messages never include the subscription URL or node
//! content, since both carry the device credential.

use std::io::Read;
use std::time::Duration;

use super::uri_parser::{parse_vless_uri, Node};

pub const MAX_SUBSCRIPTION_BYTES: usize = 64 * 1024;

const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Resolve user input from the import dialog into a node.
///
/// Accepts either a direct `vless://` share link or an `https://` plain-text
/// subscription URL containing exactly one VLESS node. Clash YAML and other
/// formats are not supported by Pingu's importer.
pub fn resolve_import_node(input: &str) -> Result<Node, String> {
    let input = input.trim();
    if input.starts_with("vless://") {
        return parse_vless_uri(input);
    }
    if input.starts_with("https://") {
        return fetch_subscription_node(input);
    }
    Err(
        "Pingu imports a vless:// node link or an https:// subscription URL. \
         Clash YAML and other subscription formats are not supported."
            .to_string(),
    )
}

/// Fetch a single-device subscription over HTTPS.
///
/// Runs on a blocking worker; callers must keep it off the config mutex.
pub fn fetch_subscription_node(url: &str) -> Result<Node, String> {
    super::profiles::validate_https_url(url, "Subscription")?;

    let agent = super::profiles::subscription_fetch_agent(FETCH_TIMEOUT);

    let response = agent.get(url).call().map_err(|err| match err {
        ureq::Error::Status(status, _) => subscription_status_error(status),
        ureq::Error::Transport(_) => {
            "Unable to reach the subscription server. Check the URL and your network connection, then try again."
                .to_string()
        }
    })?;

    let status = response.status();
    if (300..400).contains(&status) {
        return Err(
            "Subscription server returned a redirect. Pingu imports direct subscription links only; use the final https:// URL."
                .to_string(),
        );
    }
    if status != 200 {
        return Err(subscription_status_error(status));
    }

    let content_type = response.header("Content-Type").map(str::to_string);
    let mut reader = response.into_reader();
    let body = read_bounded(&mut reader, MAX_SUBSCRIPTION_BYTES)?;
    validate_subscription_response(status, content_type.as_deref(), &body)
}

/// Validate a fetched subscription body and parse its single node.
///
/// Pure (no network) so the HTTPS contract can be regression-tested with
/// injected fixtures.
pub fn validate_subscription_response(
    status: u16,
    content_type: Option<&str>,
    body: &[u8],
) -> Result<Node, String> {
    if status != 200 {
        return Err(subscription_status_error(status));
    }
    if let Some(content_type) = content_type {
        let content_type = content_type.to_ascii_lowercase();
        if content_type.contains("text/html") || content_type.contains("application/xhtml") {
            return Err(
                "Subscription URL returned an HTML page instead of a plain-text node list. Paste the vless:// node link directly instead."
                    .to_string(),
            );
        }
    }
    if body.is_empty() {
        return Err(
            "Subscription response is empty. Re-copy the subscription link from the web console."
                .to_string(),
        );
    }
    let text = String::from_utf8(body.to_vec())
        .map_err(|_| "Subscription content is not valid UTF-8 text.".to_string())?;
    parse_subscription_body(&text)
}

/// Parse a plain-text subscription body, requiring exactly one VLESS node.
pub fn parse_subscription_body(body: &str) -> Result<Node, String> {
    let mut uris: Vec<&str> = Vec::new();
    for line in body.lines() {
        let line = line.trim();
        if line.starts_with("vless://") {
            uris.push(line);
        }
    }
    match uris.len() {
        0 => {
            // Sniff for HTML that arrived without a useful Content-Type.
            let sniff = body.trim_start().to_ascii_lowercase();
            if sniff.starts_with("<!doctype html") || sniff.starts_with("<html") || sniff.starts_with("<")
            {
                return Err(
                    "Subscription URL returned an HTML page instead of a plain-text node list. Paste the vless:// node link directly instead."
                        .to_string(),
                );
            }
            Err(
                "Subscription contains no vless:// node links. Pingu imports subscriptions with exactly one device node."
                    .to_string(),
            )
        }
        1 => parse_vless_uri(uris[0]).map_err(|_| {
            "Subscription node link is invalid. Re-copy the device link from the web console."
                .to_string()
        }),
        count => Err(format!(
            "Subscription contains {} node links, but Pingu imports subscriptions with exactly one device node. Paste the single vless:// link directly instead.",
            count
        )),
    }
}

fn read_bounded(reader: &mut impl Read, limit: usize) -> Result<Vec<u8>, String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = reader
            .read(&mut chunk)
            .map_err(|_| "Failed while reading subscription content.".to_string())?;
        if read == 0 {
            break;
        }
        if buffer.len() + read > limit {
            return Err(format!(
                "Subscription content exceeds the {} KiB limit. Pingu imports single-device subscriptions only.",
                limit / 1024
            ));
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    Ok(buffer)
}
fn subscription_status_error(status: u16) -> String {
    format!(
        "Subscription server returned HTTP {} instead of the expected node content.",
        status
    )
}

#[cfg(test)]
mod tests;
