//! Minimal glob for `dir_list` / `file_search`: `*`, `?`, `[abc]`, `[a-z]`,
//! `[!x]`, and `{a,b}` alternation (nesting allowed). `**` crosses `/`; a
//! single `*` and `?` do not. A glob without `/` matches the entry name only.

const MAX_ALTERNATIVES: usize = 64;

pub struct Glob {
    patterns: Vec<Vec<char>>,
    match_path: bool,
}

impl Glob {
    pub fn new(glob: &str) -> Result<Self, String> {
        if glob.len() > 512 {
            return Err("glob is longer than 512 bytes".into());
        }
        let mut patterns = Vec::new();
        expand_braces(glob, &mut patterns)?;
        Ok(Self {
            patterns: patterns.into_iter().map(|p| p.chars().collect()).collect(),
            match_path: glob.contains('/'),
        })
    }

    /// `name` is the entry name, `rel` the path relative to the walk root.
    pub fn matches(&self, name: &str, rel: &str) -> bool {
        let subject: Vec<char> = if self.match_path { rel } else { name }.chars().collect();
        self.patterns.iter().any(|p| glob_match(p, &subject))
    }
}

fn expand_braces(pattern: &str, out: &mut Vec<String>) -> Result<(), String> {
    let chars: Vec<char> = pattern.chars().collect();
    let Some(open) = chars.iter().position(|c| *c == '{') else {
        out.push(pattern.to_string());
        return Ok(());
    };
    let mut depth = 0;
    let mut close = None;
    let mut commas = Vec::new();
    for (i, c) in chars.iter().enumerate().skip(open) {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(i);
                    break;
                }
            }
            ',' if depth == 1 => commas.push(i),
            _ => {}
        }
    }
    let Some(close) = close else {
        // Unbalanced brace: treat literally.
        out.push(pattern.to_string());
        return Ok(());
    };
    let prefix: String = chars[..open].iter().collect();
    let suffix: String = chars[close + 1..].iter().collect();
    let mut start = open + 1;
    let mut bounds = commas;
    bounds.push(close);
    for end in bounds {
        let alt: String = chars[start..end].iter().collect();
        start = end + 1;
        expand_braces(&format!("{prefix}{alt}{suffix}"), out)?;
        if out.len() > MAX_ALTERNATIVES {
            return Err("glob expands to too many alternatives".into());
        }
    }
    Ok(())
}

#[derive(Debug, Clone)]
enum Token {
    Lit(char),
    Any,
    /// `*`: any run without `/`.
    Star,
    /// `**`: any run, including `/`.
    DoubleStar,
    /// `**/`: zero or more whole directory segments.
    DoubleStarSlash,
    Class {
        negate: bool,
        items: Vec<(char, char)>,
    },
}

fn tokenize(pat: &[char]) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < pat.len() {
        match pat[i] {
            '*' if pat.get(i + 1) == Some(&'*') => {
                if pat.get(i + 2) == Some(&'/') {
                    tokens.push(Token::DoubleStarSlash);
                    i += 3;
                } else {
                    tokens.push(Token::DoubleStar);
                    i += 2;
                }
            }
            '*' => {
                tokens.push(Token::Star);
                i += 1;
            }
            '?' => {
                tokens.push(Token::Any);
                i += 1;
            }
            '[' => match parse_class(pat, i) {
                Some((token, next)) => {
                    tokens.push(token);
                    i = next;
                }
                None => {
                    tokens.push(Token::Lit('['));
                    i += 1;
                }
            },
            c => {
                tokens.push(Token::Lit(c));
                i += 1;
            }
        }
    }
    tokens
}

fn parse_class(pat: &[char], start: usize) -> Option<(Token, usize)> {
    let mut i = start + 1;
    let negate = matches!(pat.get(i), Some('!' | '^'));
    if negate {
        i += 1;
    }
    let mut items = Vec::new();
    let mut first = true;
    while i < pat.len() {
        if pat[i] == ']' && !first {
            return Some((Token::Class { negate, items }, i + 1));
        }
        first = false;
        if pat.get(i + 1) == Some(&'-') && pat.get(i + 2).is_some_and(|c| *c != ']') {
            items.push((pat[i], pat[i + 2]));
            i += 3;
        } else {
            items.push((pat[i], pat[i]));
            i += 1;
        }
    }
    None
}

/// O(pattern x text) matcher (no exponential backtracking on hostile globs).
fn glob_match(pat: &[char], text: &[char]) -> bool {
    let tokens = tokenize(pat);
    let n = text.len();
    let mut row = vec![false; n + 1];
    row[0] = true;
    for token in &tokens {
        let mut next = vec![false; n + 1];
        match token {
            Token::Lit(c) => {
                for i in 0..n {
                    next[i + 1] = row[i] && text[i] == *c;
                }
            }
            Token::Any => {
                for i in 0..n {
                    next[i + 1] = row[i] && text[i] != '/';
                }
            }
            Token::Class { negate, items } => {
                for i in 0..n {
                    let hit = items
                        .iter()
                        .any(|(lo, hi)| *lo <= text[i] && text[i] <= *hi);
                    next[i + 1] = row[i] && text[i] != '/' && hit != *negate;
                }
            }
            Token::Star => {
                next[0] = row[0];
                for i in 0..n {
                    next[i + 1] = row[i + 1] || (next[i] && text[i] != '/');
                }
                // `next[i]` already includes staying at the same token, so a
                // run of non-slash characters is absorbed.
            }
            Token::DoubleStar => {
                next[0] = row[0];
                for i in 0..n {
                    next[i + 1] = row[i + 1] || next[i];
                }
            }
            Token::DoubleStarSlash => {
                let mut any_before = false;
                for i in 0..=n {
                    any_before |= row[i];
                    next[i] = any_before && (i == 0 || text[i - 1] == '/' || row[i]);
                }
            }
        }
        row = next;
    }
    row[n]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_table() {
        let rows: &[(&str, &str, &str, bool)] = &[
            ("*.gguf", "q4.gguf", "sub/q4.gguf", true),
            ("*.gguf", "q4.gguf.part", "q4.gguf.part", false),
            ("*.{sh,yaml,yml}", "a.yml", "a.yml", true),
            ("*.{sh,yaml,yml}", "a.yaml", "a.yaml", true),
            ("*.{sh,yaml,yml}", "a.json", "a.json", false),
            ("a?c", "abc", "abc", true),
            ("a?c", "ac", "ac", false),
            ("[a-c]x", "bx", "bx", true),
            ("[!a-c]x", "bx", "bx", false),
            ("[!a-c]x", "dx", "dx", true),
            ("*", "any", "any", true),
            ("src/*.rs", "lib.rs", "src/lib.rs", true),
            ("src/*.rs", "lib.rs", "src/a/lib.rs", false),
            ("src/**/*.rs", "lib.rs", "src/a/b/lib.rs", true),
            ("{a,b{1,2}}.txt", "b2.txt", "b2.txt", true),
            ("{a,b{1,2}}.txt", "b3.txt", "b3.txt", false),
            ("a{b", "a{b", "a{b", true),
            ("", "", "", true),
            ("**", "x", "d/x", true),
        ];
        for (pat, name, rel, expected) in rows {
            let glob = Glob::new(pat).unwrap();
            assert_eq!(
                glob.matches(name, rel),
                *expected,
                "{pat} vs {name} / {rel}"
            );
        }
    }

    #[test]
    fn brace_explosion_is_bounded() {
        let pattern = "{a,b}".repeat(10);
        assert!(Glob::new(&pattern).is_err());
    }
}
