import { state } from './state.js';
import { supabaseClient } from './supabase.js';
import { el, friendlyError, icon, refreshIcons, showToast } from './ui.js';

/* ----------------- Komentarze pod książką ----------------- */
const MAX_LENGTH = 500;
const firstName = name => (name || '?').split(' ')[0];

function when(iso) {
  const d = new Date(iso);
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  const time = d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  if (days <= 0) return `dziś ${time}`;
  if (days === 1) return `wczoraj ${time}`;
  return d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'long' });
}

// Sekcja komentarzy do jednej przeczytanej książki: lista i pole do dopisania własnego
export function commentsSection(book) {
  const me = state.currentUser;
  const title = el('h3', { class: 'bs-comments-title', text: 'Komentarze' });
  const list = el('ul', { class: 'bs-comments-list' });
  const section = el('section', { class: 'bs-comments', 'aria-label': 'Komentarze' }, [title, list]);
  if (!me || !book.id) return section;

  let comments = [];

  const render = () => {
    title.textContent = comments.length ? `Komentarze (${comments.length})` : 'Komentarze';
    list.replaceChildren(...(comments.length
      ? comments.map(c => {
          const canDelete = c.user_id === me.id || book.user_id === me.id;
          const remove = canDelete
            ? el('button', { type: 'button', class: 'bs-comment-del', 'aria-label': 'Usuń komentarz', title: 'Usuń komentarz' }, [icon('trash-2')])
            : null;
          remove?.addEventListener('click', () => removeComment(c));
          return el('li', { class: `bs-comment${c.user_id === me.id ? ' mine' : ''}` }, [
            el('div', { class: 'bs-comment-head' }, [
              el('strong', { text: c.user_id === me.id ? 'Ty' : firstName(c.profiles?.display_name) }),
              el('span', { class: 'bs-comment-when', text: when(c.created_at) }),
              ...(remove ? [remove] : []),
            ]),
            el('p', { class: 'bs-comment-body', text: c.body }),
          ]);
        })
      : [el('li', { class: 'bs-comments-empty', text: 'Jeszcze nikt nic nie napisał.' })]));
    refreshIcons();
  };

  async function removeComment(c) {
    if (!confirm('Usunąć ten komentarz?')) return;
    const { data, error } = await supabaseClient.from('book_comments').delete().eq('id', c.id).select('id');
    if (error || !data?.length) {
      showToast('Nie udało się usunąć: ' + (error ? friendlyError(error) : 'brak uprawnień.'));
      return;
    }
    comments = comments.filter(x => x.id !== c.id);
    render();
  }

  async function load() {
    const { data, error } = await supabaseClient
      .from('book_comments')
      .select('id, user_id, body, created_at, profiles(display_name)')
      .eq('read_id', book.id)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (error) {
      console.error('Error loading comments:', error);
      list.replaceChildren(el('li', { class: 'bs-comments-empty', text: 'Nie udało się wczytać komentarzy.' }));
      return;
    }
    comments = data || [];
    render();
  }

  const input = el('textarea', {
    class: 'plain-input bs-comment-input',
    rows: '2',
    maxlength: String(MAX_LENGTH),
    placeholder: 'Napisz komentarz…',
    'aria-label': 'Nowy komentarz',
  });
  const send = el('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, [icon('send'), el('span', { text: 'Wyślij' })]);
  const form = el('form', { class: 'bs-comment-form' }, [input, send]);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    send.disabled = true;
    const { data, error } = await supabaseClient
      .from('book_comments')
      .insert({ read_id: book.id, body })
      .select('id, user_id, body, created_at, profiles(display_name)')
      .single();
    send.disabled = false;
    if (error) {
      showToast('Nie udało się dodać komentarza: ' + friendlyError(error));
      return;
    }
    input.value = '';
    comments.push(data);
    render();
  });
  section.appendChild(form);

  list.replaceChildren(el('li', { class: 'bs-comments-empty', text: 'Wczytuję…' }));
  load();
  return section;
}
