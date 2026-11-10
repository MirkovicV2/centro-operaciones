// 13: owner/repo keeps the case GitHub shows. Records saved before that change are in
// lower case, so every comparison between a stored value and an observed one ignores case.
export const sameRepository = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length > 0 && a.toLowerCase() === b.toLowerCase();
