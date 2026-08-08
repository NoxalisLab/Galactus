// Fixture for the Lezer outline. Every construct the Rust table claims to
// know appears exactly once, in a stable order.
mod util;

use std::fmt;

pub struct Point {
    x: f64,
    y: f64,
}

pub enum Shape {
    Circle,
    Square,
}

pub trait Draw {
    fn draw(&self);
}

impl Draw for Point {
    fn draw(&self) {}
}

pub fn main() {
    let p = Point { x: 0.0, y: 0.0 };
    p.draw();
}
