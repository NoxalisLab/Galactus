# Galactus Desktop v0.1.25

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

This one gives the agent your documents: a spreadsheet of instructions on
one side, Word and PDF files to change on the other, all of it on your Mac
and none of it leaving it.

## A spreadsheet finally reads as a table

An .xlsx used to arrive as its list of words followed by a grid of numbers,
because a sheet stores indexes into a shared string table and dates as the
day counts they are. Anything driven by that table was one bad join away
from the wrong result. Workbooks now read back as CSV, one block per sheet,
carrying the Excel row number so a report can name a row you can find. Empty
cells keep their column, dates read as dates, and a formula gives the value
you see in the cell.

## Word documents can be edited, and keep their layout

Replace a sentence, add a paragraph after another, add one at the end. Only
the parts that hold the text are rewritten; styles, images, numbering, page
setup and everything else are copied through untouched, which a test checks
entry by entry.

It searches the joined text of each paragraph rather than each run, so a
sentence with a bold word in the middle is still found, and it looks in
headers, footers, footnotes, table cells and text boxes, not only the body.

## PDFs too, with the trade a PDF imposes

The same four operations. A replacement covers the old sentence and draws
the new one in its place, and the page that changed is re-drawn as an image
so the old words really are gone rather than merely hidden under a white
box. That page loses its selectable text; every other page keeps it.

## What a Word document cannot do, said out loud

There are no pages in a .docx. Word computes them when it lays the file out,
from the paper size, the fonts, the images and even the printer driver, so
the same document paginates differently on two machines. Asking for a page
is refused with the reason and with what to use instead: a range between two
headings ("Article 4" to "Article 5"), a paragraph number, or an occurrence
number. Searching also reports how many explicit page breaks a document
carries, so the point can be shown rather than argued. On a PDF, pages exist
and page numbers work.

## Housekeeping

A new skill, `documents-depuis-tableau`, teaches the order that keeps a
batch honest: restate the table before touching anything, dry run every row
with the operation that writes nothing, show it for approval, then edit and
re-read. Nothing above adds a dependency: PDFKit and Vision ship with macOS,
zipfile and ElementTree ship with Python, and both scripts refuse a document
that declares XML entities before parsing it.
