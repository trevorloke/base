/* The voter guide's embed (VG): put after its iframe on another website. The
   guide tells this page how tall it is; the frame grows to fit. */
(function () {
  var me = document.currentScript;
  var origin = me ? new URL(me.src).origin : '';
  window.addEventListener('message', function (e) {
    if (e.origin !== origin || !e.data || e.data.type !== 'basewin:height') return;
    var h = Number(e.data.h);
    if (!(h > 200 && h < 20000)) return;
    var frames = document.getElementsByTagName('iframe');
    for (var i = 0; i < frames.length; i += 1) {
      if (frames[i].contentWindow === e.source) { frames[i].style.height = Math.ceil(h) + 'px'; frames[i].style.minHeight = '0'; }
    }
  });
}());
