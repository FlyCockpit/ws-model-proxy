//! Streaming 24 kHz to 16 kHz resampler for s16le mono PCM.
//!
//! Upsample by 2 (zero stuffing), low-pass with a windowed-sinc FIR, then keep
//! every third sample: a 2/3 polyphase resampler. State carries across calls,
//! including a split sample (an odd byte), so the output does not depend on
//! how the input is framed. No dependency; deterministic for a given input.

use std::collections::VecDeque;

/// Taps of the low-pass filter at the 48 kHz intermediate rate.
const TAPS: usize = 96;
/// Cutoff (Hz) at the 48 kHz intermediate rate: below the 8 kHz output
/// Nyquist with room for the Blackman transition band.
const CUTOFF_HZ: f64 = 7_000.0;
const INTERMEDIATE_HZ: f64 = 48_000.0;

pub struct Resampler24To16 {
    taps: [f64; TAPS],
    /// The newest input samples; `history[0]` has global index `base`.
    history: VecDeque<i16>,
    base: u64,
    /// Input samples consumed so far.
    consumed: u64,
    /// Index of the next output sample.
    next_out: u64,
    /// The first byte of a sample split across calls.
    carry: Option<u8>,
}

impl Default for Resampler24To16 {
    fn default() -> Self {
        Self::new()
    }
}

impl Resampler24To16 {
    pub fn new() -> Self {
        let center = (TAPS - 1) as f64 / 2.0;
        let cutoff = CUTOFF_HZ / INTERMEDIATE_HZ;
        let mut taps = [0.0; TAPS];
        for (k, tap) in taps.iter_mut().enumerate() {
            let t = k as f64 - center;
            let x = 2.0 * cutoff * t;
            let sinc = if x == 0.0 {
                1.0
            } else {
                (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
            };
            let phase = 2.0 * std::f64::consts::PI * k as f64 / (TAPS - 1) as f64;
            let blackman = 0.42 - 0.5 * phase.cos() + 0.08 * (2.0 * phase).cos();
            *tap = sinc * blackman;
        }
        // Unity gain at DC, doubled for the zero-stuffed (half-energy) input.
        let sum: f64 = taps.iter().sum();
        for tap in &mut taps {
            *tap *= 2.0 / sum;
        }
        Self {
            taps,
            history: VecDeque::with_capacity(TAPS / 2 + 2),
            base: 0,
            consumed: 0,
            next_out: 0,
            carry: None,
        }
    }

    /// Feeds s16le bytes and appends every output sample now computable.
    pub fn push(&mut self, bytes: &[u8], out: &mut Vec<i16>) {
        let mut bytes = bytes;
        if let Some(low) = self.carry.take() {
            let Some((&high, rest)) = bytes.split_first() else {
                self.carry = Some(low);
                return;
            };
            self.push_sample(i16::from_le_bytes([low, high]), out);
            bytes = rest;
        }
        let mut pairs = bytes.chunks_exact(2);
        for pair in pairs.by_ref() {
            self.push_sample(i16::from_le_bytes([pair[0], pair[1]]), out);
        }
        if let [low] = pairs.remainder() {
            self.carry = Some(*low);
        }
    }

    fn push_sample(&mut self, sample: i16, out: &mut Vec<i16>) {
        self.history.push_back(sample);
        self.consumed += 1;
        // Output m sits at intermediate index 3m, which needs input floor(3m/2).
        while (3 * self.next_out) / 2 < self.consumed {
            out.push(self.output(self.next_out));
            self.next_out += 1;
        }
        // Drop input no later output can reach: index < (3m - (TAPS - 1)) / 2.
        let oldest = (3 * self.next_out)
            .saturating_sub(TAPS as u64 - 1)
            .div_ceil(2);
        while self.base < oldest && !self.history.is_empty() {
            self.history.pop_front();
            self.base += 1;
        }
    }

    fn output(&self, m: u64) -> i16 {
        let position = 3 * m;
        let mut acc = 0.0;
        for (k, tap) in self.taps.iter().enumerate() {
            let Some(index) = position.checked_sub(k as u64) else {
                break;
            };
            // Zero-stuffed: only even intermediate indexes carry input.
            if index % 2 != 0 {
                continue;
            }
            let input = index / 2;
            if input < self.base {
                continue;
            }
            if let Some(sample) = self.history.get((input - self.base) as usize) {
                acc += tap * f64::from(*sample);
            }
        }
        acc.round().clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as i16
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes_of(samples: &[i16]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    fn sine(frequency: f64, amplitude: f64, rate: f64, count: usize) -> Vec<i16> {
        (0..count)
            .map(|n| {
                (amplitude * (2.0 * std::f64::consts::PI * frequency * n as f64 / rate).sin())
                    .round() as i16
            })
            .collect()
    }

    fn resample(samples: &[i16]) -> Vec<i16> {
        let mut out = Vec::new();
        Resampler24To16::new().push(&bytes_of(samples), &mut out);
        out
    }

    fn peak(samples: &[i16]) -> i16 {
        samples
            .iter()
            .map(|s| s.saturating_abs())
            .max()
            .unwrap_or(0)
    }

    #[test]
    fn two_output_samples_for_every_three_inputs() {
        assert_eq!(resample(&[0; 24_000]).len(), 16_000);
        assert_eq!(resample(&[0; 3]).len(), 2);
        assert!(resample(&[]).is_empty());
    }

    #[test]
    fn keeps_dc_and_speech_band_and_removes_what_would_alias() {
        // DC: unity gain once the filter has filled.
        let dc = resample(&[1000; 4800]);
        assert!(dc[100..].iter().all(|s| (999..=1001).contains(s)), "{dc:?}");
        // 1 kHz keeps its amplitude.
        let speech = resample(&sine(1_000.0, 10_000.0, 24_000.0, 24_000));
        let kept = peak(&speech[200..]);
        assert!((9_800..=10_200).contains(&kept), "1 kHz peak {kept}");
        // 11 kHz is above the 8 kHz output Nyquist; it must not alias to 5 kHz.
        let high = resample(&sine(11_000.0, 10_000.0, 24_000.0, 24_000));
        assert!(
            peak(&high[200..]) < 100,
            "11 kHz leaked {}",
            peak(&high[200..])
        );
        // Full scale stays in range.
        let loud = resample(&sine(1_000.0, 32_767.0, 24_000.0, 2_400));
        assert!(loud.iter().all(|s| *s > i16::MIN));
    }

    #[test]
    fn an_impulse_gives_the_filter_response() {
        let mut input = vec![0i16; 300];
        input[150] = 16_384;
        let out = resample(&input);
        let energy: i64 = out.iter().map(|s| i64::from(*s).abs()).sum();
        assert!(energy > 0);
        // Input 150 is intermediate 300; the 47.5-tap group delay puts the
        // peak at intermediate ~347.5, output ~116 (about 1 ms late).
        let (at, _) = out
            .iter()
            .enumerate()
            .max_by_key(|(_, s)| s.saturating_abs())
            .expect("peak");
        assert!((115..=117).contains(&at), "peak at {at}");
    }

    #[test]
    fn output_does_not_depend_on_framing() {
        let input = bytes_of(&sine(440.0, 12_000.0, 24_000.0, 7_001));
        let whole = {
            let mut out = Vec::new();
            Resampler24To16::new().push(&input, &mut out);
            out
        };
        for frame in [1, 2, 3, 7, 641, 4_800] {
            let mut resampler = Resampler24To16::new();
            let mut out = Vec::new();
            for chunk in input.chunks(frame) {
                resampler.push(chunk, &mut out);
            }
            assert_eq!(out, whole, "frame size {frame}");
        }
    }
}
