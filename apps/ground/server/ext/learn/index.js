// ImagineU — training for volunteers and supporters: courses of modules,
// each module a mix of materials (its words and file, then documents,
// video, audio, pictures, links, notes in order), and a "done" per person
// per module — the module is the marker of progress.
//
//   sql.js      learn_sections (courses), learn_lessons (modules), learn_parts
//               (a module's materials), learn_assets, learn_done
//   actions.js  learn.section.*, learn.lesson.*, learn.asset.upload (desk);
//               learn.done (anyone)
//   api.js      GET /learn, /learn/lessons/:id, /learn/assets/:id;
//               /learn/progress (desk)
//   public.js   /learn/<slug>[/<id>] for lessons marked public; /learn-files
// The files themselves are not in the export (they are documents, not
// records); the lessons and who has done what are.
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
export { publicRoutes } from './public.js';
export const deskOnlyReads = ['/learn/progress'];
export const exportTables = ['learn_sections', 'learn_lessons', 'learn_parts', 'learn_done'];
