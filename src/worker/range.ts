export interface ParsedRange {
  offset: number
  length: number
  end: number
}

export function parseRange(header: string | null, totalSize: number): ParsedRange | null {
  if (!header) {
    return null
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) {
    return null
  }

  const startText = match[1]
  const endText = match[2]
  if (!startText && !endText) {
    return null
  }

  let start: number
  let end: number

  if (!startText) {
    const suffixLength = Number.parseInt(endText, 10)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null
    }
    start = Math.max(totalSize - suffixLength, 0)
    end = totalSize - 1
  } else {
    start = Number.parseInt(startText, 10)
    end = endText ? Number.parseInt(endText, 10) : totalSize - 1
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= totalSize) {
    return null
  }

  end = Math.min(end, totalSize - 1)
  return {
    offset: start,
    end,
    length: end - start + 1,
  }
}

