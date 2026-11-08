globalThis.IdeaView = (() => {
  const focusNames = { ux: 'Diseño UX', code: 'Código', mixed: 'Mixto', '': 'Sin clasificar' };
  const defaults = () => ({ project: '', focus: '', tag: '', status: 'active', order: 'recent' });
  const compare = (a, b) => String(a || '').localeCompare(String(b || ''), 'es', { sensitivity: 'base' });
  const tie = (a, b) => compare(b.createdAt, a.createdAt) || String(a.id).localeCompare(String(b.id), 'en');
  const missingLast = (a, b) => !a !== !b ? (a ? -1 : 1) : compare(a, b);
  function select(ideas, business, prefs) {
    const ranks = { ux: 0, code: 1, mixed: 2, '': 3 };
    return ideas.filter(idea => idea.business === business && (idea.status || 'active') === prefs.status
      && (!prefs.project || (prefs.project === 'none' ? !idea.projectId : idea.projectId === prefs.project))
      && (!prefs.focus || (prefs.focus === 'none' ? !idea.focus : idea.focus === prefs.focus))
      && (!prefs.tag || (idea.tags || []).some(tag => compare(tag, prefs.tag) === 0)))
      .sort((a, b) => ({ recent: () => tie(a, b), old: () => missingLast(a.createdAt, b.createdAt) || tie(a, b), title: () => missingLast(a.title, b.title) || tie(a, b), project: () => missingLast(a.projectName, b.projectName) || tie(a, b), focus: () => (ranks[a.focus || ''] - ranks[b.focus || '']) || tie(a, b) }[prefs.order] || (() => tie(a, b)))());
  }
  return { defaults, select, focusNames };
})();
