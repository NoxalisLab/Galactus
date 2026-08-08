"""Fixture for the Lezer outline (Python)."""

import os
from typing import List


class Widget:
    def __init__(self, name):
        self.name = name

    def render(self):
        return self.name


def main(argv: List[str]) -> int:
    w = Widget(os.sep)
    print(w.render())
    return 0
