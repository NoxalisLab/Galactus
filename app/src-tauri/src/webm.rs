//! Splitting the engine's WebM into what WebKit will actually play.
//!
//! WHY THIS EXISTS. MiniMax-H3 generates picture and sound in one pass, and
//! the engine muxes the sound into the WebM as `A_PCM/INT/LIT`. Matroska
//! allows that; the WebM subset does not, and WKWebView answers
//! MEDIA_ERR_SRC_NOT_SUPPORTED for the WHOLE file, measured with a WKWebView
//! probe on this machine: not a silent clip, a tile the app cannot open at
//! all. VLC and ffmpeg read the same file happily, which is why the engine is
//! not wrong so much as writing for players this app does not use.
//!
//! THE ENGINE STAYS STOCK. The registry's oldest promise about this engine is
//! that it ships as published. So the fix is here, after the fact: walk the
//! EBML tree, keep the video, carry the PCM off into a WAV next to the clip,
//! and re-serialise a WebM that is actually WebM. The view plays the pair.
//!
//! BY HAND, LIKE THE BASE64. An EBML walker that knows six container IDs is
//! two hundred lines; a Matroska crate is a dependency with its own opinions
//! parked in the supply chain forever. Same trade as b64, same answer.

/// The element IDs this walker has to understand. Everything else is copied
/// through as an opaque leaf, which is what makes the walker small: only the
/// path from the root to the audio track and the audio blocks needs names.
mod id {
    pub const SEGMENT: u32 = 0x1853_8067;
    pub const TRACKS: u32 = 0x1654_AE6B;
    pub const TRACK_ENTRY: u32 = 0xAE;
    pub const CLUSTER: u32 = 0x1F43_B675;
    pub const BLOCK_GROUP: u32 = 0xA0;
    pub const SIMPLE_BLOCK: u32 = 0xA3;
    pub const BLOCK: u32 = 0xA1;
    pub const TRACK_NUMBER: u32 = 0xD7;
    pub const CODEC_ID: u32 = 0x86;
    pub const AUDIO: u32 = 0xE1;
    pub const SAMPLING_FREQUENCY: u32 = 0xB5;
    pub const CHANNELS: u32 = 0x9F;
    /// Both hold byte offsets into the Segment that stop being true the
    /// moment anything is removed, so both are dropped rather than repaired.
    pub const SEEK_HEAD: u32 = 0x114D_9B74;
    pub const CUES: u32 = 0x1C53_BB6B;
}

/// What came out of one split: the rewritten WebM and the audio, if any.
pub struct Split {
    pub webm: Vec<u8>,
    /// 16-bit little-endian PCM as a ready WAV file, None when the source
    /// had no audio track, which is every Wan clip.
    pub wav: Option<Vec<u8>>,
}

/// Split a WebM the engine wrote into a video-only WebM and a WAV.
///
/// Returns None when the bytes do not parse as EBML at all; a file this
/// cannot read is left exactly as it was, because a half-understood rewrite
/// of a media file is strictly worse than the original.
pub fn split_audio(src: &[u8]) -> Option<Split> {
    let mut r = Reader { data: src, at: 0 };
    let mut out = Vec::with_capacity(src.len());
    let mut audio = AudioSide::default();

    while r.remaining() > 0 {
        let (eid, payload) = r.element()?;
        if eid == id::SEGMENT {
            let rebuilt = rebuild_segment(payload, &mut audio)?;
            write_element(&mut out, eid, &rebuilt);
        } else {
            // The EBML header, and anything else at the top level.
            write_element(&mut out, eid, payload);
        }
    }

    let wav = if audio.pcm.is_empty() {
        None
    } else {
        Some(wav_file(&audio.pcm, audio.channels, audio.sample_rate))
    };
    Some(Split { webm: out, wav })
}

/// Everything learned about the audio track while walking.
struct AudioSide {
    /// The Matroska track number carrying `A_*`, 0 while unknown.
    track: u64,
    channels: u16,
    sample_rate: u32,
    pcm: Vec<u8>,
}

impl Default for AudioSide {
    fn default() -> Self {
        // The engine's actual output format, kept as the fallback for a file
        // whose Audio element omits a field: 32 kHz stereo is what H3 makes.
        AudioSide { track: 0, channels: 2, sample_rate: 32_000, pcm: Vec::new() }
    }
}

fn rebuild_segment(payload: &[u8], audio: &mut AudioSide) -> Option<Vec<u8>> {
    let mut r = Reader { data: payload, at: 0 };
    let mut out = Vec::with_capacity(payload.len());
    while r.remaining() > 0 {
        let (eid, body) = r.element()?;
        match eid {
            // Offsets into a Segment about to shrink: dropped, not repaired.
            // Players rebuild what they need; a wrong offset is worse than none.
            id::SEEK_HEAD | id::CUES => {}
            id::TRACKS => {
                let rebuilt = rebuild_tracks(body, audio)?;
                write_element(&mut out, eid, &rebuilt);
            }
            id::CLUSTER => {
                let rebuilt = rebuild_cluster(body, audio)?;
                write_element(&mut out, eid, &rebuilt);
            }
            _ => write_element(&mut out, eid, body),
        }
    }
    Some(out)
}

fn rebuild_tracks(payload: &[u8], audio: &mut AudioSide) -> Option<Vec<u8>> {
    let mut r = Reader { data: payload, at: 0 };
    let mut out = Vec::with_capacity(payload.len());
    while r.remaining() > 0 {
        let (eid, body) = r.element()?;
        if eid == id::TRACK_ENTRY && track_is_audio(body, audio)? {
            // The audio TrackEntry vanishes with its blocks. A track listed
            // but never fed would make some demuxers wait forever.
            continue;
        }
        write_element(&mut out, eid, body);
    }
    Some(out)
}

/// Whether one TrackEntry is the audio track, harvesting its format if so.
fn track_is_audio(body: &[u8], audio: &mut AudioSide) -> Option<bool> {
    let mut r = Reader { data: body, at: 0 };
    let mut number = 0u64;
    let mut is_audio = false;
    while r.remaining() > 0 {
        let (eid, val) = r.element()?;
        match eid {
            id::TRACK_NUMBER => number = uint_of(val),
            id::CODEC_ID => is_audio = val.starts_with(b"A_"),
            id::AUDIO => {
                let mut a = Reader { data: val, at: 0 };
                while a.remaining() > 0 {
                    let (aid, aval) = a.element()?;
                    match aid {
                        id::SAMPLING_FREQUENCY => {
                            let hz = float_of(aval);
                            if hz > 0.0 {
                                audio.sample_rate = hz as u32;
                            }
                        }
                        id::CHANNELS => audio.channels = uint_of(aval).max(1) as u16,
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    if is_audio {
        audio.track = number;
    }
    Some(is_audio)
}

fn rebuild_cluster(payload: &[u8], audio: &mut AudioSide) -> Option<Vec<u8>> {
    let mut r = Reader { data: payload, at: 0 };
    let mut out = Vec::with_capacity(payload.len());
    while r.remaining() > 0 {
        let (eid, body) = r.element()?;
        match eid {
            id::SIMPLE_BLOCK => {
                if !claim_if_audio(body, audio)? {
                    write_element(&mut out, eid, body);
                }
            }
            id::BLOCK_GROUP => {
                // The engine writes SimpleBlocks, but a BlockGroup wrapping a
                // Block is the other legal spelling and costs four lines.
                let mut g = Reader { data: body, at: 0 };
                let mut ours = false;
                while g.remaining() > 0 {
                    let (gid, gval) = g.element()?;
                    if gid == id::BLOCK && claim_if_audio(gval, audio)? {
                        ours = true;
                    }
                }
                if !ours {
                    write_element(&mut out, eid, body);
                }
            }
            _ => write_element(&mut out, eid, body),
        }
    }
    Some(out)
}

/// If this block belongs to the audio track, take its samples and say so.
///
/// Block layout: track number as a VINT, two bytes of timecode, one of
/// flags, then payload. The PCM is appended in file order, which is play
/// order for the contiguous stream the engine writes.
fn claim_if_audio(block: &[u8], audio: &mut AudioSide) -> Option<bool> {
    let mut r = Reader { data: block, at: 0 };
    let track = r.vint_value()?;
    if audio.track == 0 || track != audio.track {
        return Some(false);
    }
    let rest = r.rest();
    if rest.len() < 3 {
        return None;
    }
    audio.pcm.extend_from_slice(&rest[3..]);
    Some(true)
}

// ----------------------------------------------------------------- plumbing

struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn remaining(&self) -> usize {
        self.data.len() - self.at
    }

    fn rest(&self) -> &'a [u8] {
        &self.data[self.at..]
    }

    /// One element: its ID and its payload slice.
    fn element(&mut self) -> Option<(u32, &'a [u8])> {
        let eid = self.element_id()?;
        let size = self.vint_value()?;
        // An unknown-size element (all value bits set) only legally appears
        // on Segment or Cluster written by a streamer. The engine sizes
        // everything, so an unknown size here means "not the file this was
        // written for" and the caller keeps the original bytes.
        let size = usize::try_from(size).ok()?;
        if self.remaining() < size {
            return None;
        }
        let body = &self.data[self.at..self.at + size];
        self.at += size;
        Some((eid, body))
    }

    /// An element ID, marker bit kept, as the u32 every `id::` constant uses.
    fn element_id(&mut self) -> Option<u32> {
        let first = *self.data.get(self.at)?;
        let len = leading_len(first)?;
        if len > 4 || self.remaining() < len {
            return None;
        }
        let mut v = 0u32;
        for i in 0..len {
            v = (v << 8) | self.data[self.at + i] as u32;
        }
        self.at += len;
        Some(v)
    }

    /// A size or track-number VINT: marker bit stripped, value returned.
    fn vint_value(&mut self) -> Option<u64> {
        let first = *self.data.get(self.at)?;
        let len = leading_len(first)?;
        if len > 8 || self.remaining() < len {
            return None;
        }
        let mut v = (first as u64) & ((1 << (8 - len)) - 1);
        for i in 1..len {
            v = (v << 8) | self.data[self.at + i] as u64;
        }
        self.at += len;
        Some(v)
    }
}

/// How many bytes a VINT starting with this byte occupies. None for 0x00,
/// which is not a legal VINT start and means the walk is lost.
fn leading_len(first: u8) -> Option<usize> {
    if first == 0 {
        return None;
    }
    Some(first.leading_zeros() as usize + 1)
}

fn uint_of(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0u64, |acc, b| (acc << 8) | *b as u64)
}

/// EBML floats are 4 or 8 bytes, big-endian. Anything else reads as 0.
fn float_of(bytes: &[u8]) -> f64 {
    match bytes.len() {
        4 => f32::from_be_bytes(bytes.try_into().unwrap()) as f64,
        8 => f64::from_be_bytes(bytes.try_into().unwrap()),
        _ => 0.0,
    }
}

fn write_element(out: &mut Vec<u8>, eid: u32, payload: &[u8]) {
    // The ID, exactly the bytes it came with: the marker encodes the length.
    let id_len = 4 - (eid.leading_zeros() as usize / 8);
    out.extend_from_slice(&eid.to_be_bytes()[4 - id_len..]);
    write_size(out, payload.len() as u64);
    out.extend_from_slice(payload);
}

/// A size VINT, minimal length. The all-ones patterns mean "unknown size",
/// so a value that would land on one is written one byte longer.
fn write_size(out: &mut Vec<u8>, size: u64) {
    for len in 1..=8usize {
        let max = (1u64 << (7 * len)) - 1;
        if size < max {
            let marked = size | (1u64 << (7 * len));
            out.extend_from_slice(&marked.to_be_bytes()[8 - len..]);
            return;
        }
    }
    // Sizes past 2^56 do not come out of this engine; write the 8-byte form.
    let marked = size | (1u64 << 56);
    out.extend_from_slice(&marked.to_be_bytes());
}

/// PCM16LE wrapped in the 44-byte canonical WAV header.
fn wav_file(pcm: &[u8], channels: u16, sample_rate: u32) -> Vec<u8> {
    let byte_rate = sample_rate * channels as u32 * 2;
    let block_align = channels * 2;
    let mut w = Vec::with_capacity(44 + pcm.len());
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes()); // PCM
    w.extend_from_slice(&channels.to_le_bytes());
    w.extend_from_slice(&sample_rate.to_le_bytes());
    w.extend_from_slice(&byte_rate.to_le_bytes());
    w.extend_from_slice(&block_align.to_le_bytes());
    w.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    w.extend_from_slice(b"data");
    w.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    w.extend_from_slice(pcm);
    w
}

#[cfg(test)]
mod tests {
    use super::*;

    // A miniature Matroska built by the same writer the splitter uses, which
    // is fair: write_element is exercised by every parse test anyway, and a
    // hand-hexed fixture would test the author's hex instead.

    fn leaf(eid: u32, body: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        write_element(&mut v, eid, body);
        v
    }

    fn simple_block(track: u8, payload: &[u8]) -> Vec<u8> {
        // Track VINT (one byte, marker 0x80), timecode 0, flags 0.
        let mut b = vec![0x80 | track, 0, 0, 0x80];
        b.extend_from_slice(payload);
        leaf(id::SIMPLE_BLOCK, &b)
    }

    fn tiny_file(with_audio: bool) -> Vec<u8> {
        let video_entry = {
            let mut e = leaf(id::TRACK_NUMBER, &[1]);
            e.extend(leaf(id::CODEC_ID, b"V_VP8"));
            leaf(id::TRACK_ENTRY, &e)
        };
        let audio_entry = {
            let mut e = leaf(id::TRACK_NUMBER, &[2]);
            e.extend(leaf(id::CODEC_ID, b"A_PCM/INT/LIT"));
            let mut a = leaf(id::SAMPLING_FREQUENCY, &32000.0f32.to_be_bytes());
            a.extend(leaf(id::CHANNELS, &[2]));
            e.extend(leaf(id::AUDIO, &a));
            leaf(id::TRACK_ENTRY, &e)
        };
        let mut tracks = video_entry;
        if with_audio {
            tracks.extend(audio_entry);
        }
        let mut segment = leaf(id::SEEK_HEAD, b"stale offsets");
        segment.extend(leaf(id::TRACKS, &tracks));
        let mut cluster = simple_block(1, b"video frame one");
        if with_audio {
            cluster.extend(simple_block(2, b"PCMA"));
        }
        cluster.extend(simple_block(1, b"video frame two"));
        if with_audio {
            cluster.extend(simple_block(2, b"PCMB"));
        }
        segment.extend(leaf(id::CLUSTER, &cluster));
        segment.extend(leaf(id::CUES, b"stale too"));
        let mut file = leaf(0x1A45_DFA3, b"ebml header, copied verbatim");
        file.extend(leaf(id::SEGMENT, &segment));
        file
    }

    #[test]
    fn the_audio_track_leaves_whole_and_the_video_stays() {
        let split = split_audio(&tiny_file(true)).expect("parses");
        let wav = split.wav.expect("audio came out");
        // The PCM is the blocks' payloads in order, behind the 44-byte header.
        assert_eq!(&wav[44..], b"PCMAPCMB");
        // 32 kHz stereo, read from the track rather than assumed.
        assert_eq!(&wav[24..28], &32000u32.to_le_bytes());
        assert_eq!(&wav[22..24], &2u16.to_le_bytes());
        let out = split.webm;
        let flat = |needle: &[u8]| out.windows(needle.len()).any(|w| w == needle);
        assert!(flat(b"video frame one") && flat(b"video frame two"));
        assert!(!flat(b"PCMA"), "no audio block survives");
        assert!(!flat(b"A_PCM/INT/LIT"), "no audio track entry survives");
        assert!(flat(b"V_VP8"), "the video track entry survives");
        assert!(!flat(b"stale offsets") && !flat(b"stale too"), "SeekHead and Cues are dropped, not kept wrong");
        // And the rewrite parses again, which is what a player will do.
        assert!(split_audio(&out).is_some());
    }

    #[test]
    fn a_file_with_no_audio_passes_through_intact_but_for_the_indexes() {
        let split = split_audio(&tiny_file(false)).expect("parses");
        assert!(split.wav.is_none(), "nothing invented");
        let flat = |needle: &[u8]| split.webm.windows(needle.len()).any(|w| w == needle);
        assert!(flat(b"video frame one") && flat(b"V_VP8"));
    }

    #[test]
    fn bytes_that_are_not_ebml_are_refused_not_rewritten() {
        assert!(split_audio(b"\x00\x00\x00not matroska").is_none());
        assert!(split_audio(b"").map(|s| s.webm.is_empty()).unwrap_or(true));
    }

    /// The real thing, on demand: point GALACTUS_WEBM at an engine-written
    /// clip and this splits it next to the source for a WKWebView probe.
    /// Ignored because it needs a file only some machines have.
    #[test]
    #[ignore]
    fn split_a_real_engine_file() {
        let path = std::env::var("GALACTUS_WEBM").expect("set GALACTUS_WEBM");
        let src = std::fs::read(&path).expect("readable");
        let split = split_audio(&src).expect("an engine file must parse");
        let base = path.trim_end_matches(".webm");
        std::fs::write(format!("{base}-video-only.webm"), &split.webm).unwrap();
        if let Some(wav) = split.wav {
            std::fs::write(format!("{base}-sound.wav"), &wav).unwrap();
        }
    }

    #[test]
    fn vints_survive_the_round_trip_at_every_length_boundary() {
        // The boundaries where a size needs one more byte, including the
        // all-ones values that would read back as "unknown size" if written
        // at minimal length.
        for size in [0u64, 126, 127, 128, 16_382, 16_383, 16_384, (1 << 21) - 2, 1 << 21, (1 << 28) - 2] {
            let mut buf = Vec::new();
            write_size(&mut buf, size);
            let mut r = Reader { data: &buf, at: 0 };
            let got = r.vint_value().expect("reads back");
            assert_eq!(got, size, "size {size} round-trips");
            // And it must not read as the unknown-size pattern.
            let len = buf.len();
            let all_ones = (1u64 << (7 * len)) - 1;
            assert_ne!(got, all_ones, "size {size} must not collide with unknown-size");
        }
    }
}
