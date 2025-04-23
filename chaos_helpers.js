"use strict";

// ------------------------------------------------------------------------------------------------
// Fetcher - to avoid multiple fetches by the bots... written by Claude, mostly...
// This is maybe the 3rd, simplest version of this.

let fetcher_promises = Object.create(null);			// Holds only promises.

// Remember multiple callers may get the same promise, which will resolve to the same response
// unless we do something about it. What we need to do is ensure each return out of this function
// (thankfully there's just one return now) adds a .then() which clones it.

exports.fetcher = function(url, options = {}) {		// Must always return a promise.

	if (typeof url !== "string") {
		return Promise.reject(new Error("fetcher: expected string"));
	}

	if (!Object.hasOwn(fetcher_promises, url)) {

		fetcher_promises[url] = fetch(url, options).then(response => {

			if (!response.ok) {
				delete fetcher_promises[url];
				throw new Error(`HTTP error! status: ${response.status}`);
			}

			setTimeout(() => {
				delete fetcher_promises[url];
			}, 300000);								// Remove from cache after 5 minutes

			return response;
		});
	}

	return fetcher_promises[url].then(response => response.clone());
};

// ------------------------------------------------------------------------------------------------

exports.split_text_into_chunks = function(text, maxlen) {			// Written by Claude.

	// Reduce effective maxlen by 30 characters to create buffer space for code block handling
	let true_maxlen = maxlen;
	maxlen -= 30;

	text = text.replace(/\n(?:\s*\n)+/g, "\n\n");
	text = text.trim();

	// If empty, return empty
	if (text.length === 0) {
		return [];
	}

	// If text is short enough, just return it
	if (text.length <= true_maxlen) {
		return [text];
	}

	let chunks = [];

	// Try to split at paragraph boundaries first
	let paragraphs = text.split("\n\n");
	let current_chunk = "";

	for (let i = 0; i < paragraphs.length; i++) {
		let paragraph = paragraphs[i];

		// If a single paragraph is longer than maxlen, we'll need to split it
		if (paragraph.length > maxlen) {
			// First send the current chunk if it exists
			if (current_chunk) {
				chunks.push(current_chunk);
				current_chunk = "";
			}

			// Split long paragraph by sentences or just characters if needed
			let paragraphChunks = exports.split_paragraph(paragraph, maxlen);
			chunks = chunks.concat(paragraphChunks);
		}
		// If adding this paragraph would exceed maxlen, push current chunk and start a new one
		else if (current_chunk.length + paragraph.length + 2 > maxlen) {
			chunks.push(current_chunk);
			current_chunk = paragraph;
		}
		// Otherwise add the paragraph to the current chunk
		else {
			if (current_chunk) {
				current_chunk += "\n\n" + paragraph;
			} else {
				current_chunk = paragraph;
			}
		}
	}

	// Don't forget the last chunk
	if (current_chunk) {
		chunks.push(current_chunk);
	}

	chunks = chunks.map(s => s.trim()).filter(s => s !== "");

	// Process code blocks that might be split across chunks, passing the true maxlen
	return exports.fix_code_blocks(chunks, true_maxlen);
};

exports.split_paragraph = function(paragraph, maxlen) {			// Written by Claude.

	// If paragraph is short enough, just return it
	if (paragraph.length <= maxlen) {
		return [paragraph];
	}

	let chunks = [];

	// Try to split by sentences first
	let sentences = paragraph.split(/(?<=[.!?])\s+/);
	let current_chunk = "";

	for (let sentence of sentences) {
		// If single sentence is too long, we'll need to split it by characters
		if (sentence.length > maxlen) {
			// Send current chunk if it exists
			if (current_chunk) {
				chunks.push(current_chunk);
				current_chunk = "";
			}

			// Split by characters with some buffer for code blocks
			for (let i = 0; i < sentence.length; i += maxlen) {
				chunks.push(sentence.substring(i, i + maxlen));
			}
		}
		// If adding this sentence would exceed maxlen, start a new chunk
		else if (current_chunk.length + sentence.length + 1 > maxlen) {
			chunks.push(current_chunk);
			current_chunk = sentence;
		}
		// Otherwise add the sentence to current chunk
		else {
			if (current_chunk) {
				current_chunk += " " + sentence;
			} else {
				current_chunk = sentence;
			}
		}
	}

	// Don't forget the last chunk
	if (current_chunk) {
		chunks.push(current_chunk);
	}

	return chunks;
};

exports.fix_code_blocks = function (chunks, true_maxlen) {		// Written by o3

/**
 * Fixes unbalanced Markdown ``` fences created when long text is split into
 * separate Discord messages.   The algorithm guarantees that **each individual
 * chunk is a well‑formed message** (an even number of triple‑backtick fences)
 * while preserving the original language spec where possible.
 *
 * Strategy in brief:
 *   1. Track whether the previous chunk ended *inside* a code‑block.  If so we
 *      reopen that block at the start of the next chunk.
 *   2. Count every ``` fence in the current chunk to see whether we are still
 *      inside a block when we reach the end.
 *   3. If the block is still open, append a closing fence (space permitting)
 *      and remember the language so it can be reopened in the following chunk.
 *
 * @param {string[]} chunks      – output of split_text_into_chunks before repair
 * @param {number}   true_maxlen – *full* per‑message limit (not the reduced
 *                                value that split_text_into_chunks works with)
 * @returns {string[]}           – chunks with balanced code fences
 */

	if (!Array.isArray(chunks) || chunks.length <= 1) return chunks;

	const result = [];
	let reopenLang = null;                // language to reopen in next chunk

	for (let chunk of chunks) {
		// 1. Re‑open if we previously closed a block purely because of length
		if (reopenLang !== null) {
			const opener = "```" + (reopenLang || "") + "\n";
			if (chunk.length + opener.length <= true_maxlen) {
				chunk = opener + chunk;
			} else if (chunk.length + 4 <= true_maxlen) {   // fallback w/out lang
				chunk = "```\n" + chunk;
			}
		}

		// 2. Scan every ``` fence in the chunk and toggle an in‑block flag
		const fences = [...chunk.matchAll(/```(\w*)?/g)];
		let inBlock = false;
		let currentLang = reopenLang;      // carry‑over from step 1 if any

		for (const match of fences) {
			if (inBlock) {
				inBlock = false;          // this fence closes the block
				currentLang = null;
			} else {
				inBlock = true;           // this fence opens the block
				currentLang = match[1] ?? "";
			}
		}

		// 3. If the block is still open when we reach the end of the chunk,
		//    close it so each Discord message stands on its own.
		if (inBlock) {
			if (chunk.length + 4 <= true_maxlen) {
				chunk += "\n```";        // close it now…
			}
			// ...but remember to reopen it in the next chunk.
			reopenLang = currentLang;
		} else {
			reopenLang = null;
		}

		result.push(chunk);
	}

	return result;
};

// ------------------------------------------------------------------------------------------------

exports.probably_text = function(content_type) {
	if (typeof content_type !== "string") {
		return false;
	}
	if (content_type.includes("charset=utf")) {
		return true;
	}
	for (let foo of ["text/", "application/json", "application/javascript", "application/x-python"]) {
		if (content_type.startsWith(foo)) {
			return true;
		}
	}
	return false;
};

exports.normalize_linebreaks = function(text) {
	text = text.replace(/\r\n/g, "\n");
	text = text.replace(/\r/g, "\n");
	return text;
};

exports.centre_string = function(s, width) {
	if (s.length >= width) {
		return s;
	}
	let total_padding = width - s.length;
	let left_padding = Math.floor(total_padding / 2);
	return " ".repeat(left_padding) + s;
};

exports.format_timestamp = function(date) {
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	const seconds = String(date.getSeconds()).padStart(2, "0");
	const month = date.toLocaleString("en-GB", { month: "short" });
	const day = String(date.getDate()).padStart(2, "0");
	const year = date.getFullYear();
	return `${hours}:${minutes}:${seconds} on ${month} ${day}, ${year}`;
};

exports.date_from_snowflake = function(snowflake) {		// Unused but good to have.
	if (typeof snowflake === "string") {
		snowflake = BigInt(snowflake);
	}
	if (typeof snowflake !== "bigint") {
		throw new Error("date_from_snowflake: invalid argument");
	}
	let unixtime = BigInt(1420070400000) + (snowflake >> BigInt(22));
	return new Date(Number(unixtime));
};
