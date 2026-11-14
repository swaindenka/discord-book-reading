import { describe, expect, it } from 'vitest';
import { isUsableMetadataTitle, looksLikeRawFilename, parseBookFilename } from '../shared/bookname.js';

describe('parseBookFilename', () => {
  it.each([
    [
      "A Man Called Ove A Novel -- Fredrik Backman -- 064e814eedc0c7d1152773539bbe2acd -- Anna's Archive.pdf",
      { title: 'A Man Called Ove', author: 'Fredrik Backman' },
    ],
    [
      "Project Hail Mary -- Andy Weir -- Ballantine Books, 2021 -- 9780593135204 -- 2f0e4c1b9d8a7e6f5a4b3c2d1e0f9a8b -- Anna’s Archive.epub",
      { title: 'Project Hail Mary', author: 'Andy Weir' },
    ],
    ['The Hobbit (J.R.R. Tolkien) (z-lib.org).epub', { title: 'The Hobbit (J.R.R. Tolkien)', author: null }],
    ['Dune_Frank_Herbert.pdf', { title: 'Dune Frank Herbert', author: null }],
    ['Pride.and.Prejudice.epub', { title: 'Pride and Prejudice', author: null }],
    ['notes.md', { title: 'notes', author: null }],
    ["Circe -- Madeline Miller -- 2018 -- Little, Brown and Company -- isbn13 9780316556347 -- 9f8e7d6c5b4a -- Z-Library.epub", { title: 'Circe', author: 'Madeline Miller' }],
  ])('%s', (input, expected) => {
    expect(parseBookFilename(input)).toEqual(expected);
  });

  it('recognises names that were cut short (room names are capped at 60 characters)', () => {
    const truncated = 'A Man Called Ove A Novel -- Fredrik Backman -- 064e814eedc0';
    expect(looksLikeRawFilename(truncated)).toBe(true);
    expect(parseBookFilename(truncated).title).toBe('A Man Called Ove');
    expect(looksLikeRawFilename('Friday Night Book Club')).toBe(false);
    expect(looksLikeRawFilename('Dune -- Part Two')).toBe(false);
  });

  it('rejects junk metadata titles', () => {
    expect(isUsableMetadataTitle('A Man Called Ove')).toBe(true);
    expect(isUsableMetadataTitle('Microsoft Word - ove_final.docx')).toBe(false);
    expect(isUsableMetadataTitle('untitled')).toBe(false);
    expect(isUsableMetadataTitle('0123456789')).toBe(false);
    expect(isUsableMetadataTitle('')).toBe(false);
  });
});
