/**
 * Короткая вставка для шаблона сайта ПЕРЕД строкой скрипта окна (задание от 20.11.2026, п. 6–7):
 * клик по кнопке до загрузки окна встаёт в очередь RfMessenger._q и выполняется после загрузки;
 * если окно не загрузилось за 5 с (сеть, блокировщик) — кнопке «Онлайн-чат» показываются запасные ссылки
 * на мессенджеры (data-fallback="#id блока со ссылками" или блок .rfd-chat-fallback рядом с кнопкой). Цель chat_open
 * при этом не отправляется — её шлёт только само окно.
 */
export const LOADER_SNIPPET = `(function(){if(window.RfMessenger)return;var q=[];var api={ready:false,_q:q,open:function(){q.length=0;q.push('open');wait()},close:function(){q.length=0;q.push('close')},toggle:function(){q.length=0;q.push('toggle');wait()}};window.RfMessenger=api;var t=null;function wait(){if(t)return;t=setTimeout(function(){if(window.RfMessenger&&window.RfMessenger.ready)return;var btns=document.querySelectorAll('[data-action="open-rf-messenger"]');for(var i=0;i<btns.length;i++){var b=btns[i];var sel=b.getAttribute('data-fallback');var fb=sel?document.querySelector(sel):(b.parentElement&&b.parentElement.querySelector('.rfd-chat-fallback'));if(fb){fb.hidden=false;fb.style.display='';}b.setAttribute('data-rfd-fallback','1');}},5000)}document.addEventListener('click',function(e){var el=e.target;while(el&&el.nodeType===1&&!(el.getAttribute&&el.getAttribute('data-action')==='open-rf-messenger'))el=el.parentNode;if(!el||el.nodeType!==1)return;if(window.RfMessenger&&window.RfMessenger.ready)return;e.preventDefault();api.open()})})();`;
