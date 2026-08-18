//! A small regular expression engine, for the project search.
//!
//! WHY THIS EXISTS. Search was literal only, and the note in search.rs said why:
//! a regex crate is a dependency, a NOTICE entry and a licence review. That
//! reasoning is sound about pulling one in; it is not a reason for an editor to
//! have no regex search at all, which is the one search feature people reach for
//! when they are renaming an API or auditing a pattern across a repository.
//!
//! WHAT IT SUPPORTS. Literals, `.`, character classes with ranges and negation,
//! the usual escapes (`\d \w \s` and their negations, `\n \t \r`, and a
//! backslash before any punctuation), the quantifiers `* + ? {n} {n,} {n,m}`,
//! alternation, groups, and the anchors `^` and `$`.
//!
//! WHAT IT DOES NOT, and will not. No backreferences and no lookaround. Both are
//! outside what this construction can express, and both are what turn a regex
//! engine into something that can hang on a pattern a user typed by accident.
//! An unsupported construct is a clear error message, never a silent misreading:
//! a pattern that quietly means something other than what it says is worse than
//! one that is refused.
//!
//! WHY IT CANNOT HANG. It is a Thompson construction simulated with a set of
//! states, not a backtracker. Every input character advances every live state
//! once, so the work is bounded by (length of the line) x (size of the pattern),
//! whatever the pattern is. The classic disaster, `(a+)+$` against a line of
//! a's, is linear here.
//!
//! MATCHING IS PER LINE. The project search reads files line by line, `.` does
//! not cross a newline, and `^` and `$` mean what a person expects them to mean:
//! the ends of the line they can see. That is also what bounds memory: the state
//! set is the size of one line, never of one file.

/// One compiled instruction.
#[derive(Debug, Clone)]
enum Inst {
    /// Consume one character if it is in the class.
    Class(Class),
    /// Try both branches, in this order.
    Split(usize, usize),
    Jump(usize),
    /// Zero-width: start of line.
    Start,
    /// Zero-width: end of line.
    End,
    Match,
}

/// A set of characters: a literal, a range list, or one of the shorthands.
#[derive(Debug, Clone)]
struct Class {
    /// Inclusive ranges over chars.
    ranges: Vec<(char, char)>,
    /// Shorthand members, kept apart so `\w` inside a class stays cheap.
    digits: bool,
    words: bool,
    spaces: bool,
    negated: bool,
    /// `.`: everything. Kept explicit so it does not need 0x10FFFF ranges.
    any: bool,
}

impl Class {
    fn empty() -> Self {
        Class {
            ranges: Vec::new(),
            digits: false,
            words: false,
            spaces: false,
            negated: false,
            any: false,
        }
    }

    fn literal(c: char) -> Self {
        let mut k = Class::empty();
        k.ranges.push((c, c));
        k
    }

    fn any_char() -> Self {
        let mut k = Class::empty();
        k.any = true;
        k
    }

    fn contains(&self, c: char, fold: bool) -> bool {
        if self.any {
            // `.` matches everything on the line; the line has no newline in it.
            return true;
        }
        let hit = self.hit(c) || (fold && self.folded_hit(c));
        hit != self.negated
    }

    fn hit(&self, c: char) -> bool {
        if self.digits && c.is_ascii_digit() {
            return true;
        }
        if self.words && (c.is_alphanumeric() || c == '_') {
            return true;
        }
        if self.spaces && c.is_whitespace() {
            return true;
        }
        self.ranges.iter().any(|(a, b)| c >= *a && c <= *b)
    }

    /// Case-insensitive matching, done here rather than by lowercasing the
    /// subject: the offsets must stay those of the source text, and lowercasing
    /// can change how many bytes a character takes.
    fn folded_hit(&self, c: char) -> bool {
        for alt in c.to_lowercase().chain(c.to_uppercase()) {
            if alt != c && self.hit(alt) {
                return true;
            }
        }
        false
    }
}

// ---------------------------------------------------------------- parser
//
// A plain recursive descent over the pattern, producing instructions directly.
// The grammar is small enough that an AST in between would only be ceremony:
//
//   alt   := concat ('|' concat)*
//   concat:= repeat*
//   repeat:= atom ('*' | '+' | '?' | '{n,m}')?
//   atom  := '(' alt ')' | '[' class ']' | '.' | '^' | '$' | escape | char

struct Parser<'a> {
    chars: Vec<char>,
    at: usize,
    prog: &'a mut Vec<Inst>,
}

/// The ceiling on a compiled pattern. Reached only by a quantifier repeat count
/// large enough that the user meant something else: `a{1,100000}` is not a
/// search, and expanding it would be tens of thousands of instructions.
const MAX_PROG: usize = 4096;
/// The largest repetition a `{n,m}` may ask for.
const MAX_REPEAT: u32 = 512;

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }

    fn next(&mut self) -> Option<char> {
        let c = self.peek();
        if c.is_some() {
            self.at += 1;
        }
        c
    }

    fn eat(&mut self, c: char) -> bool {
        if self.peek() == Some(c) {
            self.at += 1;
            return true;
        }
        false
    }

    fn emit(&mut self, i: Inst) -> Result<usize, String> {
        if self.prog.len() >= MAX_PROG {
            return Err("that pattern is too large".into());
        }
        self.prog.push(i);
        Ok(self.prog.len() - 1)
    }

    /// alt := concat ('|' concat)*
    fn alt(&mut self) -> Result<(), String> {
        let start = self.prog.len();
        self.concat()?;
        while self.eat('|') {
            // Splice a Split in front of the left branch, then a Jump over the
            // right one. Splicing means rewriting the jump targets that moved.
            let split = start;
            self.prog.insert(split, Inst::Split(0, 0));
            shift_targets(self.prog, split, 1);
            let jump = self.emit(Inst::Jump(0))?;
            let right = self.prog.len();
            self.concat()?;
            let after = self.prog.len();
            self.prog[split] = Inst::Split(split + 1, right);
            self.prog[jump] = Inst::Jump(after);
        }
        Ok(())
    }

    /// concat := repeat*
    fn concat(&mut self) -> Result<(), String> {
        while let Some(c) = self.peek() {
            if c == '|' || c == ')' {
                break;
            }
            self.repeat()?;
        }
        Ok(())
    }

    /// repeat := atom quantifier?
    fn repeat(&mut self) -> Result<(), String> {
        let start = self.prog.len();
        self.atom()?;
        let Some(q) = self.peek() else { return Ok(()) };
        match q {
            '*' => {
                self.at += 1;
                self.star(start)?;
            }
            '+' => {
                self.at += 1;
                self.plus(start)?;
            }
            '?' => {
                self.at += 1;
                self.optional(start)?;
            }
            '{' => {
                // Only a real counted repetition; a lone '{' is a literal brace,
                // which is what someone searching for JSON has typed.
                if let Some((min, max, after)) = self.counted() {
                    self.at = after;
                    self.counted_repeat(start, min, max)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn star(&mut self, start: usize) -> Result<(), String> {
        self.prog.insert(start, Inst::Split(0, 0));
        shift_targets(self.prog, start, 1);
        let jump = self.emit(Inst::Jump(start))?;
        self.prog[start] = Inst::Split(start + 1, jump + 1);
        Ok(())
    }

    fn plus(&mut self, start: usize) -> Result<(), String> {
        let split = self.emit(Inst::Split(0, 0))?;
        self.prog[split] = Inst::Split(start, split + 1);
        Ok(())
    }

    fn optional(&mut self, start: usize) -> Result<(), String> {
        self.prog.insert(start, Inst::Split(0, 0));
        shift_targets(self.prog, start, 1);
        let after = self.prog.len();
        self.prog[start] = Inst::Split(start + 1, after);
        Ok(())
    }

    /// `{n}`, `{n,}`, `{n,m}`, expanded by copying the atom's instructions.
    fn counted_repeat(&mut self, start: usize, min: u32, max: Option<u32>) -> Result<(), String> {
        let body: Vec<Inst> = self.prog[start..].to_vec();
        let body_len = body.len();
        if body_len == 0 {
            return Ok(());
        }
        // The first copy is already in place. Truncate and rebuild, so the code
        // below has one story rather than two.
        self.prog.truncate(start);
        let total = match max {
            Some(m) => m,
            None => min.max(1),
        };
        if total > MAX_REPEAT {
            return Err(format!("a repetition of more than {MAX_REPEAT} is not supported"));
        }
        for _ in 0..min {
            let at = self.prog.len();
            append_shifted(self.prog, &body, at as isize - start as isize)?;
        }
        match max {
            None => {
                // {n,} is n copies then a star on the last shape.
                let at = self.prog.len();
                append_shifted(self.prog, &body, at as isize - start as isize)?;
                self.star(at)?;
            }
            Some(m) => {
                for _ in min..m {
                    let at = self.prog.len();
                    append_shifted(self.prog, &body, at as isize - start as isize)?;
                    self.optional(at)?;
                }
            }
        }
        Ok(())
    }

    /// Reads `{n}`, `{n,}` or `{n,m}` without consuming anything on failure.
    fn counted(&self) -> Option<(u32, Option<u32>, usize)> {
        let mut i = self.at + 1; // past '{'
        let mut min = String::new();
        while let Some(c) = self.chars.get(i) {
            if c.is_ascii_digit() {
                min.push(*c);
                i += 1;
            } else {
                break;
            }
        }
        if min.is_empty() {
            return None;
        }
        let min_n: u32 = min.parse().ok()?;
        match self.chars.get(i) {
            Some('}') => Some((min_n, Some(min_n), i + 1)),
            Some(',') => {
                i += 1;
                let mut max = String::new();
                while let Some(c) = self.chars.get(i) {
                    if c.is_ascii_digit() {
                        max.push(*c);
                        i += 1;
                    } else {
                        break;
                    }
                }
                if self.chars.get(i) != Some(&'}') {
                    return None;
                }
                let max_n = if max.is_empty() { None } else { Some(max.parse().ok()?) };
                Some((min_n, max_n, i + 1))
            }
            _ => None,
        }
    }

    fn atom(&mut self) -> Result<(), String> {
        let Some(c) = self.next() else { return Ok(()) };
        match c {
            '(' => {
                // Groups are not captured: the search reports where a match is,
                // not what its parts were. `(?:...)` is accepted and means the
                // same thing, so a pattern pasted from elsewhere still works.
                if self.peek() == Some('?') {
                    if self.chars.get(self.at + 1) == Some(&':') {
                        self.at += 2;
                    } else {
                        return Err("(?...) groups are not supported: use (...)".into());
                    }
                }
                self.alt()?;
                if !self.eat(')') {
                    return Err("a '(' is never closed".into());
                }
                Ok(())
            }
            ')' => Err("a ')' has nothing to close".into()),
            '[' => {
                let k = self.class()?;
                self.emit(Inst::Class(k))?;
                Ok(())
            }
            '.' => {
                self.emit(Inst::Class(Class::any_char()))?;
                Ok(())
            }
            '^' => {
                self.emit(Inst::Start)?;
                Ok(())
            }
            '$' => {
                self.emit(Inst::End)?;
                Ok(())
            }
            '*' | '+' | '?' => Err(format!("'{c}' has nothing to repeat")),
            '\\' => {
                let k = self.escape()?;
                self.emit(Inst::Class(k))?;
                Ok(())
            }
            other => {
                self.emit(Inst::Class(Class::literal(other)))?;
                Ok(())
            }
        }
    }

    /// The class after a backslash, outside or inside brackets.
    fn escape(&mut self) -> Result<Class, String> {
        let Some(c) = self.next() else {
            return Err("the pattern ends with a lone backslash".into());
        };
        let mut k = Class::empty();
        match c {
            'd' => k.digits = true,
            'w' => k.words = true,
            's' => k.spaces = true,
            'D' => {
                k.digits = true;
                k.negated = true;
            }
            'W' => {
                k.words = true;
                k.negated = true;
            }
            'S' => {
                k.spaces = true;
                k.negated = true;
            }
            'n' => k.ranges.push(('\n', '\n')),
            't' => k.ranges.push(('\t', '\t')),
            'r' => k.ranges.push(('\r', '\r')),
            'b' | 'B' => {
                // A word boundary is a zero-width assertion this construction
                // does not carry. Refused rather than silently ignored: a
                // pattern that means something else than it says is worse than
                // one that is turned down.
                return Err("\\b is not supported: use the whole word option".into());
            }
            other => k.ranges.push((other, other)),
        }
        Ok(k)
    }

    /// `[...]`, with ranges, negation, and escapes inside.
    fn class(&mut self) -> Result<Class, String> {
        let mut k = Class::empty();
        if self.eat('^') {
            k.negated = true;
        }
        // A ']' first is a literal ']', the traditional rule.
        if self.peek() == Some(']') {
            self.at += 1;
            k.ranges.push((']', ']'));
        }
        loop {
            let Some(c) = self.next() else {
                return Err("a '[' is never closed".into());
            };
            if c == ']' {
                return Ok(k);
            }
            let low = if c == '\\' {
                let sub = self.escape()?;
                if sub.digits || sub.words || sub.spaces {
                    // A shorthand inside a class contributes its whole set. A
                    // negated one inside a class would need set subtraction,
                    // which this does not do.
                    if sub.negated {
                        return Err("\\D, \\W and \\S are not supported inside [...]".into());
                    }
                    k.digits |= sub.digits;
                    k.words |= sub.words;
                    k.spaces |= sub.spaces;
                    continue;
                }
                sub.ranges.first().map(|r| r.0).unwrap_or('\\')
            } else {
                c
            };
            // A range, unless the '-' is the last character before ']'.
            if self.peek() == Some('-') && self.chars.get(self.at + 1) != Some(&']') {
                self.at += 1;
                let Some(hi_raw) = self.next() else {
                    return Err("a '[' is never closed".into());
                };
                let hi = if hi_raw == '\\' {
                    let sub = self.escape()?;
                    sub.ranges.first().map(|r| r.0).unwrap_or('\\')
                } else {
                    hi_raw
                };
                if hi < low {
                    return Err(format!("the range {low}-{hi} runs backwards"));
                }
                k.ranges.push((low, hi));
            } else {
                k.ranges.push((low, low));
            }
        }
    }
}

/// Shift every jump target at or after `from` by `by`, after an insert.
fn shift_targets(prog: &mut [Inst], from: usize, by: usize) {
    for i in prog.iter_mut() {
        match i {
            Inst::Split(a, b) => {
                if *a >= from {
                    *a += by;
                }
                if *b >= from {
                    *b += by;
                }
            }
            Inst::Jump(a) => {
                if *a >= from {
                    *a += by;
                }
            }
            _ => {}
        }
    }
}

/// Append a copy of `body` with its targets moved by `delta`.
fn append_shifted(prog: &mut Vec<Inst>, body: &[Inst], delta: isize) -> Result<(), String> {
    if prog.len() + body.len() > MAX_PROG {
        return Err("that pattern is too large".into());
    }
    for i in body {
        let moved = match i {
            Inst::Split(a, b) => Inst::Split(
                (*a as isize + delta).max(0) as usize,
                (*b as isize + delta).max(0) as usize,
            ),
            Inst::Jump(a) => Inst::Jump((*a as isize + delta).max(0) as usize),
            other => other.clone(),
        };
        prog.push(moved);
    }
    Ok(())
}

// ---------------------------------------------------------------- engine

#[derive(Debug)]
pub struct Regex {
    prog: Vec<Inst>,
    fold: bool,
}

impl Regex {
    /// Compile, or say what is wrong with the pattern in words a user can act on.
    pub fn new(pattern: &str, case_sensitive: bool) -> Result<Regex, String> {
        if pattern.is_empty() {
            return Err("the pattern is empty".into());
        }
        let mut prog = Vec::new();
        {
            let mut p = Parser { chars: pattern.chars().collect(), at: 0, prog: &mut prog };
            p.alt()?;
            if p.at < p.chars.len() {
                return Err(if p.chars[p.at] == ')' {
                    "a ')' has nothing to close".to_string()
                } else {
                    format!("unexpected '{}' in the pattern", p.chars[p.at])
                });
            }
        }
        prog.push(Inst::Match);
        Ok(Regex { prog, fold: !case_sensitive })
    }

    /// Byte ranges of the non-overlapping matches in one line.
    ///
    /// Leftmost, longest: at a given start the longest match wins, and the scan
    /// resumes after it. An empty match advances by one character, so a pattern
    /// that can match nothing (`x*`) cannot spin.
    pub fn find_line(&self, line: &str) -> Vec<(usize, usize)> {
        let chars: Vec<(usize, char)> = line.char_indices().collect();
        // Longest match starting at each character index, in char units.
        let best = self.scan(&chars);
        let mut out = Vec::new();
        let mut i = 0usize;
        while i <= chars.len() {
            match best[i] {
                Some(end) if end > i => {
                    out.push((byte_at(&chars, line, i), byte_at(&chars, line, end)));
                    i = end;
                }
                _ => i += 1,
            }
        }
        out
    }

    /// One pass over the line, carrying every live thread at once.
    ///
    /// This is what makes the engine safe: a thread is identified by its
    /// instruction, so there are never more live threads than the pattern has
    /// instructions, whatever the input is.
    fn scan(&self, chars: &[(usize, char)]) -> Vec<Option<usize>> {
        let n = chars.len();
        let mut best: Vec<Option<usize>> = vec![None; n + 1];
        // (pc -> earliest start) for the current position.
        let mut current: Vec<(usize, usize)> = Vec::new();
        let mut seen = vec![usize::MAX; self.prog.len()];
        let mut next: Vec<(usize, usize)> = Vec::new();
        let mut seen_next = vec![usize::MAX; self.prog.len()];

        for pos in 0..=n {
            // Every position is also a possible start.
            self.add(&mut current, &mut seen, 0, pos, pos, n, &mut best);
            if pos == n {
                break;
            }
            let c = chars[pos].1;
            next.clear();
            for v in seen_next.iter_mut() {
                *v = usize::MAX;
            }
            for (pc, start) in current.iter().copied() {
                if let Inst::Class(k) = &self.prog[pc] {
                    if k.contains(c, self.fold) {
                        self.add(&mut next, &mut seen_next, pc + 1, start, pos + 1, n, &mut best);
                    }
                }
            }
            std::mem::swap(&mut current, &mut next);
            std::mem::swap(&mut seen, &mut seen_next);
        }
        best
    }

    /// Follow every zero-width instruction from `pc`, recording matches.
    #[allow(clippy::too_many_arguments)]
    fn add(
        &self,
        list: &mut Vec<(usize, usize)>,
        seen: &mut [usize],
        pc: usize,
        start: usize,
        pos: usize,
        n: usize,
        best: &mut [Option<usize>],
    ) {
        // A pc already reached at this position with an earlier start is the one
        // that counts: this both keeps the leftmost rule and stops the cycles a
        // pattern like (a*)* would otherwise create.
        if seen[pc] <= start {
            return;
        }
        seen[pc] = start;
        match &self.prog[pc] {
            Inst::Split(a, b) => {
                let (a, b) = (*a, *b);
                self.add(list, seen, a, start, pos, n, best);
                self.add(list, seen, b, start, pos, n, best);
            }
            Inst::Jump(a) => {
                let a = *a;
                self.add(list, seen, a, start, pos, n, best);
            }
            Inst::Start => {
                if pos == 0 {
                    self.add(list, seen, pc + 1, start, pos, n, best);
                }
            }
            Inst::End => {
                if pos == n {
                    self.add(list, seen, pc + 1, start, pos, n, best);
                }
            }
            Inst::Match => {
                // Longest wins at a given start.
                let slot = &mut best[start];
                if slot.is_none_or(|e| pos > e) {
                    *slot = Some(pos);
                }
            }
            Inst::Class(_) => list.push((pc, start)),
        }
    }
}

/// Byte offset of char index `i` (the end of the line for i == len).
fn byte_at(chars: &[(usize, char)], line: &str, i: usize) -> usize {
    chars.get(i).map(|(b, _)| *b).unwrap_or(line.len())
}

#[cfg(test)]
mod tests {
    use super::Regex;

    fn all(pattern: &str, text: &str) -> Vec<String> {
        let re = Regex::new(pattern, true).expect("compiles");
        re.find_line(text).into_iter().map(|(s, e)| text[s..e].to_string()).collect()
    }

    #[test]
    fn literals_classes_and_quantifiers() {
        assert_eq!(all("ab", "xxabyyab"), ["ab", "ab"]);
        assert_eq!(all("a.c", "abc adc a c"), ["abc", "adc", "a c"]);
        assert_eq!(all("[0-9]+", "x12y345"), ["12", "345"]);
        assert_eq!(all(r"\d+\.\d+", "v1.25 and 3.5"), ["1.25", "3.5"]);
        assert_eq!(all("colou?r", "color colour"), ["color", "colour"]);
        assert_eq!(all("a{2,3}", "a aa aaaa"), ["aa", "aaa"]);
    }

    #[test]
    fn alternation_groups_and_anchors() {
        assert_eq!(all("cat|dog", "a dog and a cat"), ["dog", "cat"]);
        assert_eq!(all("(foo|bar)baz", "foobaz barbaz bazbaz"), ["foobaz", "barbaz"]);
        assert_eq!(all("^fn ", "fn main"), ["fn "]);
        assert!(all("^fn ", "  fn main").is_empty());
        assert_eq!(all(r";$", "let x = 1;"), [";"]);
        // (?:...) means the same as (...) here, so a pasted pattern still works.
        assert_eq!(all("(?:ab)+", "ababab"), ["ababab"]);
    }

    #[test]
    fn a_negated_class_and_an_escaped_metacharacter() {
        assert_eq!(all("[^ ]+", "one two"), ["one", "two"]);
        assert_eq!(all(r"\.\*", "a.*b"), [".*"]);
        // A ']' first in a class is a literal one.
        assert_eq!(all("[]]", "a]b"), ["]"]);
    }

    #[test]
    fn case_insensitive_offsets_stay_in_the_source() {
        // The offsets must index the ORIGINAL text: a lowercased copy can change
        // how many bytes a character takes, and an offset found in that copy
        // would slice the source mid-character. Folding happens per character,
        // against the source, so this cannot happen.
        let re = Regex::new("été", false).unwrap();
        let text = "ÉTÉ et été";
        let hits: Vec<&str> = re.find_line(text).into_iter().map(|(s, e)| &text[s..e]).collect();
        assert_eq!(hits, ["ÉTÉ", "été"]);
        // Folding is case, not accents: an editor that matched ete against été
        // would be guessing at what the user meant.
        assert!(Regex::new("ete", false).unwrap().find_line(text).is_empty());
    }

    #[test]
    fn the_pattern_that_hangs_a_backtracker_is_linear_here() {
        // (a+)+$ against a long run of a's followed by a b is the classic
        // catastrophic case: exponential in a backtracker, and this test would
        // never finish. Here every character advances every state once.
        let re = Regex::new("(a+)+$", true).unwrap();
        let line = format!("{}b", "a".repeat(2000));
        let started = std::time::Instant::now();
        assert!(re.find_line(&line).is_empty());
        assert!(started.elapsed().as_secs() < 2, "the engine must not backtrack");
    }

    #[test]
    fn matches_do_not_overlap_and_an_empty_match_cannot_spin() {
        assert_eq!(all("aa", "aaaa"), ["aa", "aa"]);
        // x* matches nothing everywhere: it must terminate, not loop.
        let hits = Regex::new("x*", true).unwrap().find_line("abc");
        assert!(hits.is_empty() || hits.len() <= 3);
    }

    #[test]
    fn a_bad_pattern_says_what_is_wrong_instead_of_matching_something_else() {
        for (pattern, needle) in [
            ("(ab", "never closed"),
            ("ab)", "nothing to close"),
            ("*ab", "nothing to repeat"),
            ("[a-", "never closed"),
            ("[z-a]", "backwards"),
            (r"a\", "lone backslash"),
            (r"\bword", "not supported"),
            ("(?=x)", "not supported"),
        ] {
            let err = Regex::new(pattern, true).expect_err(pattern).to_lowercase();
            assert!(err.contains(needle), "{pattern}: {err}");
        }
    }

    #[test]
    fn a_repetition_nobody_meant_is_refused_rather_than_expanded() {
        assert!(Regex::new("a{1,100000}", true).is_err());
        // And a lone brace is a literal, which is what someone reading JSON typed.
        assert_eq!(all("{x", "a{xb"), ["{x"]);
    }
}
