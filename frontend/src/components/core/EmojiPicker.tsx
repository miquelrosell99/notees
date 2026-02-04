/**
 * EmojiPicker Component
 * 
 * A picker element with two tabs:
 * - Emojis: Standard unicode emojis
 * - Symbols: MDI (Material Design Icons)
 * 
 * Returns the emoji character or MDI icon name (e.g., "mdi-calendar")
 */
import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import Icon from '@mdi/react';
import * as mdiIcons from '@mdi/js';
import { mdiShapeOutline } from '@mdi/js';
import { Button } from './Button';
import './EmojiPicker.css';

// Emoji name mappings for search
const EMOJI_NAMES: Record<string, string[]> = {
  '😀': ['grinning', 'smile', 'happy'],
  '😃': ['grinning', 'smile', 'happy', 'joy'],
  '😄': ['smile', 'happy', 'joy', 'laugh', 'pleased'],
  '😁': ['grin', 'smile', 'happy'],
  '😊': ['blush', 'smile', 'happy', 'pleased'],
  '😍': ['heart', 'love', 'crush', 'adore'],
  '😘': ['kiss', 'love', 'heart'],
  '🥰': ['love', 'hearts', 'adore'],
  '😎': ['cool', 'sunglasses'],
  '🤔': ['thinking', 'hmm', 'consider'],
  '😂': ['joy', 'laugh', 'tears', 'lol'],
  '🤣': ['rofl', 'laugh', 'lol'],
  '😭': ['cry', 'tears', 'sad', 'sob'],
  '😡': ['angry', 'mad', 'rage'],
  '🤬': ['swear', 'curse', 'angry'],
  '😴': ['sleep', 'tired', 'zzz'],
  '🤯': ['mind', 'blown', 'explode'],
  '👍': ['thumbs', 'up', 'yes', 'ok', 'good'],
  '👎': ['thumbs', 'down', 'no', 'bad'],
  '👏': ['clap', 'applause', 'congrats'],
  '🙏': ['pray', 'thanks', 'please', 'namaste'],
  '💪': ['muscle', 'strong', 'flex'],
  '👀': ['eyes', 'look', 'see', 'watching'],
  '❤️': ['heart', 'love', 'red'],
  '💔': ['broken', 'heart', 'sad'],
  '💯': ['hundred', 'perfect', '100'],
  '🔥': ['fire', 'hot', 'lit'],
  '✨': ['sparkle', 'shine', 'star'],
  '⭐': ['star'],
  '🌟': ['star', 'glow'],
  '💡': ['light', 'bulb', 'idea'],
  '🎉': ['party', 'celebrate', 'tada'],
  '🎊': ['confetti', 'celebrate', 'party'],
  '🎈': ['balloon', 'party'],
  '🎁': ['gift', 'present', 'box'],
  '🏆': ['trophy', 'win', 'award'],
  '🥇': ['gold', 'medal', 'first', 'win'],
  '📝': ['memo', 'note', 'write', 'pencil'],
  '📌': ['pin', 'pushpin'],
  '📍': ['pin', 'location', 'map'],
  '🔖': ['bookmark', 'tag'],
  '📅': ['calendar', 'date'],
  '📆': ['calendar', 'date'],
  '⏰': ['clock', 'alarm', 'time'],
  '⌚': ['watch', 'time'],
  '📱': ['phone', 'mobile', 'iphone'],
  '💻': ['computer', 'laptop', 'mac'],
  '⌨️': ['keyboard', 'type'],
  '🖱️': ['mouse', 'click'],
  '🖥️': ['desktop', 'computer', 'monitor'],
  '📧': ['email', 'mail'],
  '📨': ['email', 'mail', 'incoming'],
  '📩': ['email', 'mail', 'envelope'],
  '📮': ['mailbox', 'post'],
  '📬': ['mailbox', 'mail'],
  '📂': ['folder', 'file'],
  '📁': ['folder', 'file'],
  '🔍': ['search', 'magnify', 'find'],
  '🔎': ['search', 'magnify', 'find'],
  '✅': ['check', 'yes', 'done', 'complete'],
  '✔️': ['check', 'yes', 'done'],
  '❌': ['x', 'cross', 'no', 'cancel'],
  '⚠️': ['warning', 'caution', 'alert'],
  '❗': ['exclamation', 'warning', 'important'],
  '❓': ['question', 'help'],
  '💭': ['thought', 'thinking', 'bubble'],
  '💬': ['speech', 'comment', 'chat'],
  '🚀': ['rocket', 'space', 'launch'],
  '✈️': ['airplane', 'plane', 'flight'],
  '🚗': ['car', 'vehicle'],
  '🏠': ['house', 'home'],
  '🏢': ['building', 'office'],
  '🌍': ['earth', 'world', 'globe'],
  '🌎': ['earth', 'world', 'globe', 'americas'],
  '🌏': ['earth', 'world', 'globe', 'asia'],
  '☀️': ['sun', 'sunny', 'weather'],
  '🌙': ['moon', 'night'],
  '⭐': ['star'],
  '🌈': ['rainbow', 'colors'],
  '☁️': ['cloud', 'weather'],
  '⛈️': ['storm', 'thunder', 'lightning'],
  '❄️': ['snow', 'cold', 'winter'],
  '🔔': ['bell', 'notification', 'alert'],
  '🔕': ['bell', 'mute', 'silent'],
  '🎵': ['music', 'note'],
  '🎶': ['music', 'notes', 'song'],
  '🎤': ['microphone', 'sing', 'karaoke'],
  '🎧': ['headphones', 'music'],
  '📷': ['camera', 'photo'],
  '📸': ['camera', 'photo', 'flash'],
  '🎨': ['art', 'palette', 'paint'],
  '✏️': ['pencil', 'write', 'edit'],
  '✂️': ['scissors', 'cut'],
  '📏': ['ruler', 'measure'],
  '📐': ['triangle', 'ruler', 'measure'],
  '🔧': ['wrench', 'tool', 'settings'],
  '🔨': ['hammer', 'tool'],
  '⚙️': ['gear', 'settings', 'config'],
  '🔗': ['link', 'chain'],
  '🔒': ['lock', 'secure', 'private'],
  '🔓': ['unlock', 'open'],
  '🔑': ['key', 'password'],
  '🎯': ['target', 'goal', 'dart'],
  '🎲': ['dice', 'game', 'random'],
  '🎮': ['game', 'controller', 'gaming'],
  '🍕': ['pizza', 'food'],
  '🍔': ['burger', 'food', 'hamburger'],
  '🍟': ['fries', 'food'],
  '🌮': ['taco', 'food'],
  '🌯': ['burrito', 'food'],
  '🍎': ['apple', 'fruit', 'red'],
  '🍌': ['banana', 'fruit'],
  '🍇': ['grapes', 'fruit'],
  '🍓': ['strawberry', 'fruit'],
  '🍉': ['watermelon', 'fruit'],
  '🍊': ['orange', 'fruit'],
  '☕': ['coffee', 'drink', 'cafe'],
  '🍵': ['tea', 'drink', 'green'],
  '🍺': ['beer', 'drink', 'cheers'],
  '🍷': ['wine', 'drink'],
  '🎂': ['cake', 'birthday', 'dessert'],
  '🍰': ['cake', 'dessert', 'slice'],
  '🍪': ['cookie', 'dessert'],
  '🍩': ['donut', 'doughnut', 'dessert'],
  '🐶': ['dog', 'puppy', 'pet'],
  '🐱': ['cat', 'kitty', 'pet'],
  '🐭': ['mouse', 'rodent'],
  '🐹': ['hamster', 'pet'],
  '🐰': ['rabbit', 'bunny'],
  '🦊': ['fox'],
  '🐻': ['bear'],
  '🐼': ['panda', 'bear'],
  '🐨': ['koala'],
  '🐯': ['tiger', 'face'],
  '🦁': ['lion'],
  '🐸': ['frog'],
  '🐵': ['monkey', 'face'],
  '🐔': ['chicken'],
  '🐧': ['penguin'],
  '🐦': ['bird'],
  '🦅': ['eagle', 'bird'],
  '🦉': ['owl', 'bird'],
  '🦋': ['butterfly'],
  '🐝': ['bee', 'honey'],
  '🐛': ['bug', 'caterpillar'],
  '🌸': ['flower', 'blossom', 'cherry'],
  '🌹': ['rose', 'flower'],
  '🌺': ['flower', 'hibiscus'],
  '🌻': ['sunflower', 'flower'],
  '🌷': ['tulip', 'flower'],
  '🌵': ['cactus', 'desert'],
  '🌲': ['tree', 'evergreen', 'pine'],
  '🌳': ['tree', 'deciduous'],
  '🎄': ['christmas', 'tree', 'xmas'],
  '🍀': ['clover', 'luck', 'four'],
  '🍁': ['maple', 'leaf', 'fall'],
  '🍂': ['leaves', 'fall', 'autumn'],
  '🍃': ['leaf', 'wind'],
  '⚡': ['lightning', 'bolt', 'electricity', 'fast'],
  '☄️': ['comet', 'space'],
  '💫': ['dizzy', 'star'],
  '💥': ['boom', 'explosion', 'bang'],
  '💦': ['water', 'drops', 'sweat'],
  '💨': ['wind', 'fast', 'dash'],
};

// Common emoji categories
const EMOJI_CATEGORIES = {
  'Smileys': ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐'],
  'Gestures': ['👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🫀', '🫁', '🦷', '🦴', '👀', '👁️', '👅', '👄'],
  'People': ['👶', '🧒', '👦', '👧', '🧑', '👱', '👨', '🧔', '👩', '🧓', '👴', '👵', '🙍', '🙎', '🙅', '🙆', '💁', '🙋', '🧏', '🙇', '🤦', '🤷', '👮', '🕵️', '💂', '🥷', '👷', '🤴', '👸', '👳', '👲', '🧕', '🤵', '👰', '🤰', '🤱', '👼', '🎅', '🤶', '🦸', '🦹', '🧙', '🧚', '🧛', '🧜', '🧝', '🧞', '🧟', '💆', '💇', '🚶', '🧍', '🧎', '🏃', '💃', '🕺', '🕴️', '👯', '🧖', '🧗', '🤸', '🏌️', '🏇', '⛷️', '🏂', '🏋️', '🤼', '🤽', '🤾', '🤺', '⛹️', '🏊', '🚣', '🧘', '🛀', '🛌'],
  'Animals': ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐽', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒', '🐔', '🐧', '🐦', '🐤', '🐣', '🐥', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🪱', '🐛', '🦋', '🐌', '🐞', '🐜', '🪰', '🪲', '🪳', '🦟', '🦗', '🕷️', '🕸️', '🦂', '🐢', '🐍', '🦎', '🦖', '🦕', '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🐊', '🐅', '🐆', '🦓', '🦍', '🦧', '🦣', '🐘', '🦛', '🦏', '🐪', '🐫', '🦒', '🦘', '🦬', '🐃', '🐂', '🐄', '🐎', '🐖', '🐏', '🐑', '🦙', '🐐', '🦌', '🐕', '🐩', '🦮', '🐕‍🦺', '🐈', '🐈‍⬛', '🪶', '🐓', '🦃', '🦤', '🦚', '🦜', '🦢', '🦩', '🕊️', '🐇', '🦝', '🦨', '🦡', '🦫', '🦦', '🦥', '🐁', '🐀', '🐿️', '🦔'],
  'Nature': ['🌵', '🎄', '🌲', '🌳', '🌴', '🪵', '🌱', '🌿', '☘️', '🍀', '🎍', '🪴', '🎋', '🍃', '🍂', '🍁', '🪺', '🪹', '🍄', '🐚', '🪸', '🪨', '🌾', '💐', '🌷', '🌹', '🥀', '🌺', '🌸', '🌼', '🌻', '🌞', '🌝', '🌛', '🌜', '🌚', '🌕', '🌖', '🌗', '🌘', '🌑', '🌒', '🌓', '🌔', '🌙', '🌎', '🌍', '🌏', '🪐', '💫', '⭐', '🌟', '✨', '⚡', '☄️', '💥', '🔥', '🌪️', '🌈', '☀️', '🌤️', '⛅', '🌥️', '☁️', '🌦️', '🌧️', '⛈️', '🌩️', '🌨️', '❄️', '☃️', '⛄', '🌬️', '💨', '💧', '💦', '🫧', '☔', '☂️', '🌊', '🌫️'],
  'Food': ['🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶️', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅', '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔', '🍟', '🍕', '🫓', '🥪', '🥙', '🧆', '🌮', '🌯', '🫔', '🥗', '🥘', '🫕', '🥫', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮', '🍢', '🍡', '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬', '🍫', '🍿', '🍩', '🍪', '🌰', '🥜', '🍯', '🥛', '🍼', '🫖', '☕', '🍵', '🧃', '🥤', '🧋', '🍶', '🍺', '🍻', '🥂', '🍷', '🥃', '🍸', '🍹', '🧉', '🍾', '🧊', '🥄', '🍴', '🍽️', '🥣', '🥡', '🥢', '🧂'],
  'Activities': ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷', '⛸️', '🥌', '🎿', '⛷️', '🏂', '🪂', '🏋️', '🤼', '🤸', '🤺', '⛹️', '🤾', '🏌️', '🏇', '🧘', '🏄', '🏊', '🤽', '🚣', '🧗', '🚵', '🚴', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️', '🏵️', '🎗️', '🎫', '🎟️', '🎪', '🤹', '🎭', '🩰', '🎨', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🪘', '🎷', '🎺', '🪗', '🎸', '🪕', '🎻', '🎲', '♟️', '🎯', '🎳', '🎮', '🎰', '🧩'],
  'Travel': ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚛', '🚜', '🦯', '🦽', '🦼', '🛴', '🚲', '🛵', '🏍️', '🛺', '🚨', '🚔', '🚍', '🚘', '🚖', '🚡', '🚠', '🚟', '🚃', '🚋', '🚞', '🚝', '🚄', '🚅', '🚈', '🚂', '🚆', '🚇', '🚊', '🚉', '✈️', '🛫', '🛬', '🛩️', '💺', '🛰️', '🚀', '🛸', '🚁', '🛶', '⛵', '🚤', '🛥️', '🛳️', '⛴️', '🚢', '⚓', '🪝', '⛽', '🚧', '🚦', '🚥', '🚏', '🗺️', '🗿', '🗽', '🗼', '🏰', '🏯', '🏟️', '🎡', '🎢', '🎠', '⛲', '⛱️', '🏖️', '🏝️', '🏜️', '🌋', '⛰️', '🏔️', '🗻', '🏕️', '⛺', '🛖', '🏠', '🏡', '🏘️', '🏚️', '🏗️', '🏢', '🏭', '🏣', '🏤', '🏥', '🏦', '🏨', '🏪', '🏫', '🏩', '💒', '🏛️', '⛪', '🕌', '🕍', '🛕', '🕋', '⛩️', '🛤️', '🛣️', '🗾', '🎑', '🏞️', '🌅', '🌄', '🌠', '🎇', '🎆', '🌇', '🌆', '🏙️', '🌃', '🌌', '🌉', '🌁'],
  'Objects': ['⌚', '📱', '📲', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '🖲️', '🕹️', '🗜️', '💽', '💾', '💿', '📀', '📼', '📷', '📸', '📹', '🎥', '📽️', '🎞️', '📞', '☎️', '📟', '📠', '📺', '📻', '🎙️', '🎚️', '🎛️', '🧭', '⏱️', '⏲️', '⏰', '🕰️', '⌛', '⏳', '📡', '🔋', '🔌', '💡', '🔦', '🕯️', '🪔', '🧯', '🛢️', '💸', '💵', '💴', '💶', '💷', '🪙', '💰', '💳', '💎', '⚖️', '🪜', '🧰', '🪛', '🔧', '🔨', '⚒️', '🛠️', '⛏️', '🪚', '🔩', '⚙️', '🪤', '🧱', '⛓️', '🧲', '🔫', '💣', '🧨', '🪓', '🔪', '🗡️', '⚔️', '🛡️', '🚬', '⚰️', '🪦', '⚱️', '🏺', '🔮', '📿', '🧿', '💈', '⚗️', '🔭', '🔬', '🕳️', '🩹', '🩺', '💊', '💉', '🩸', '🧬', '🦠', '🧫', '🧪', '🌡️', '🧹', '🪠', '🧺', '🧻', '🚽', '🚰', '🚿', '🛁', '🛀', '🧼', '🪥', '🪒', '🧽', '🪣', '🧴', '🛎️', '🔑', '🗝️', '🚪', '🪑', '🛋️', '🛏️', '🛌', '🧸', '🪆', '🖼️', '🪞', '🪟', '🛍️', '🛒', '🎁', '🎈', '🎏', '🎀', '🪄', '🪅', '🎊', '🎉', '🎎', '🏮', '🎐', '🧧', '✉️', '📩', '📨', '📧', '💌', '📥', '📤', '📦', '🏷️', '🪧', '📪', '📫', '📬', '📭', '📮', '📯', '📜', '📃', '📄', '📑', '🧾', '📊', '📈', '📉', '🗒️', '🗓️', '📆', '📅', '🗑️', '📇', '🗃️', '🗳️', '🗄️', '📋', '📁', '📂', '🗂️', '🗞️', '📰', '📓', '📔', '📒', '📕', '📗', '📘', '📙', '📚', '📖', '🔖', '🧷', '🔗', '📎', '🖇️', '📐', '📏', '🧮', '📌', '📍', '✂️', '🖊️', '🖋️', '✒️', '🖌️', '🖍️', '📝', '✏️', '🔍', '🔎', '🔏', '🔐', '🔒', '🔓'],
  'Symbols': ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❤️‍🔥', '❤️‍🩹', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐', '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '🆔', '⚛️', '🉑', '☢️', '☣️', '📴', '📳', '🈶', '🈚', '🈸', '🈺', '🈷️', '✴️', '🆚', '💮', '🉐', '㊙️', '㊗️', '🈴', '🈵', '🈹', '🈲', '🅰️', '🅱️', '🆎', '🆑', '🅾️', '🆘', '❌', '⭕', '🛑', '⛔', '📛', '🚫', '💯', '💢', '♨️', '🚷', '🚯', '🚳', '🚱', '🔞', '📵', '🚭', '❗', '❕', '❓', '❔', '‼️', '⁉️', '🔅', '🔆', '〽️', '⚠️', '🚸', '🔱', '⚜️', '🔰', '♻️', '✅', '🈯', '💹', '❇️', '✳️', '❎', '🌐', '💠', 'Ⓜ️', '🌀', '💤', '🏧', '🚾', '♿', '🅿️', '🛗', '🈳', '🈂️', '🛂', '🛃', '🛄', '🛅', '🚹', '🚺', '🚼', '⚧️', '🚻', '🚮', '🎦', '📶', '🈁', '🔣', 'ℹ️', '🔤', '🔡', '🔠', '🆖', '🆗', '🆙', '🆒', '🆕', '🆓', '0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟', '🔢', '#️⃣', '*️⃣', '⏏️', '▶️', '⏸️', '⏯️', '⏹️', '⏺️', '⏭️', '⏮️', '⏩', '⏪', '⏫', '⏬', '◀️', '🔼', '🔽', '➡️', '⬅️', '⬆️', '⬇️', '↗️', '↘️', '↙️', '↖️', '↕️', '↔️', '↪️', '↩️', '⤴️', '⤵️', '🔀', '🔁', '🔂', '🔄', '🔃', '🎵', '🎶', '➕', '➖', '➗', '✖️', '🟰', '♾️', '💲', '💱', '™️', '©️', '®️', '👁️‍🗨️', '🔚', '🔙', '🔛', '🔝', '🔜', '〰️', '➰', '➿', '✔️', '☑️', '🔘', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪', '🟤', '🔺', '🔻', '🔸', '🔹', '🔶', '🔷', '🔳', '🔲', '▪️', '▫️', '◾', '◽', '◼️', '◻️', '🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '⬛', '⬜', '🟫', '🔈', '🔇', '🔉', '🔊', '🔔', '🔕', '📣', '📢', '💬', '💭', '🗯️', '♠️', '♣️', '♥️', '♦️', '🃏', '🎴', '🀄', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛', '🕜', '🕝', '🕞', '🕟', '🕠', '🕡', '🕢', '🕣', '🕤', '🕥', '🕦', '🕧'],
  'Flags': ['🏳️', '🏴', '🏴‍☠️', '🏁', '🚩', '🎌', '🏳️‍🌈', '🏳️‍⚧️', '🇺🇳', '🇦🇫', '🇦🇱', '🇩🇿', '🇦🇸', '🇦🇩', '🇦🇴', '🇦🇮', '🇦🇶', '🇦🇬', '🇦🇷', '🇦🇲', '🇦🇼', '🇦🇺', '🇦🇹', '🇦🇿', '🇧🇸', '🇧🇭', '🇧🇩', '🇧🇧', '🇧🇾', '🇧🇪', '🇧🇿', '🇧🇯', '🇧🇲', '🇧🇹', '🇧🇴', '🇧🇦', '🇧🇼', '🇧🇷', '🇮🇴', '🇻🇬', '🇧🇳', '🇧🇬', '🇧🇫', '🇧🇮', '🇰🇭', '🇨🇲', '🇨🇦', '🇮🇨', '🇨🇻', '🇧🇶', '🇰🇾', '🇨🇫', '🇹🇩', '🇨🇱', '🇨🇳', '🇨🇽', '🇨🇨', '🇨🇴', '🇰🇲', '🇨🇬', '🇨🇩', '🇨🇰', '🇨🇷', '🇨🇮', '🇭🇷', '🇨🇺', '🇨🇼', '🇨🇾', '🇨🇿', '🇩🇰', '🇩🇯', '🇩🇲', '🇩🇴', '🇪🇨', '🇪🇬', '🇸🇻', '🇬🇶', '🇪🇷', '🇪🇪', '🇸🇿', '🇪🇹', '🇪🇺', '🇫🇰', '🇫🇴', '🇫🇯', '🇫🇮', '🇫🇷', '🇬🇫', '🇵🇫', '🇹🇫', '🇬🇦', '🇬🇲', '🇬🇪', '🇩🇪', '🇬🇭', '🇬🇮', '🇬🇷', '🇬🇱', '🇬🇩', '🇬🇵', '🇬🇺', '🇬🇹', '🇬🇬', '🇬🇳', '🇬🇼', '🇬🇾', '🇭🇹', '🇭🇳', '🇭🇰', '🇭🇺', '🇮🇸', '🇮🇳', '🇮🇩', '🇮🇷', '🇮🇶', '🇮🇪', '🇮🇲', '🇮🇱', '🇮🇹', '🇯🇲', '🇯🇵', '🎌', '🇯🇪', '🇯🇴', '🇰🇿', '🇰🇪', '🇰🇮', '🇽🇰', '🇰🇼', '🇰🇬', '🇱🇦', '🇱🇻', '🇱🇧', '🇱🇸', '🇱🇷', '🇱🇾', '🇱🇮', '🇱🇹', '🇱🇺', '🇲🇴', '🇲🇬', '🇲🇼', '🇲🇾', '🇲🇻', '🇲🇱', '🇲🇹', '🇲🇭', '🇲🇶', '🇲🇷', '🇲🇺', '🇾🇹', '🇲🇽', '🇫🇲', '🇲🇩', '🇲🇨', '🇲🇳', '🇲🇪', '🇲🇸', '🇲🇦', '🇲🇿', '🇲🇲', '🇳🇦', '🇳🇷', '🇳🇵', '🇳🇱', '🇳🇨', '🇳🇿', '🇳🇮', '🇳🇪', '🇳🇬', '🇳🇺', '🇳🇫', '🇰🇵', '🇲🇰', '🇲🇵', '🇳🇴', '🇴🇲', '🇵🇰', '🇵🇼', '🇵🇸', '🇵🇦', '🇵🇬', '🇵🇾', '🇵🇪', '🇵🇭', '🇵🇳', '🇵🇱', '🇵🇹', '🇵🇷', '🇶🇦', '🇷🇪', '🇷🇴', '🇷🇺', '🇷🇼', '🇼🇸', '🇸🇲', '🇸🇹', '🇸🇦', '🇸🇳', '🇷🇸', '🇸🇨', '🇸🇱', '🇸🇬', '🇸🇽', '🇸🇰', '🇸🇮', '🇬🇸', '🇸🇧', '🇸🇴', '🇿🇦', '🇰🇷', '🇸🇸', '🇪🇸', '🇱🇰', '🇧🇱', '🇸🇭', '🇰🇳', '🇱🇨', '🇵🇲', '🇻🇨', '🇸🇩', '🇸🇷', '🇸🇪', '🇨🇭', '🇸🇾', '🇹🇼', '🇹🇯', '🇹🇿', '🇹🇭', '🇹🇱', '🇹🇬', '🇹🇰', '🇹🇴', '🇹🇹', '🇹🇳', '🇹🇷', '🇹🇲', '🇹🇨', '🇹🇻', '🇻🇮', '🇺🇬', '🇺🇦', '🇦🇪', '🇬🇧', '🏴󠁧󠁢󠁥󠁮󠁧󠁿', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '🏴󠁧󠁢󠁷󠁬󠁳󠁿', '🇺🇸', '🇺🇾', '🇺🇿', '🇻🇺', '🇻🇦', '🇻🇪', '🇻🇳', '🇼🇫', '🇪🇭', '🇾🇪', '🇿🇲', '🇿🇼'],
};

// MDI icon categories
const MDI_CATEGORIES: Record<string, string[]> = {
  'Popular': [
    'mdiFileDocumentOutline', 'mdiCalendarToday', 'mdiBookOpenPageVariant', 'mdiNotebookOutline',
    'mdiGraphOutline', 'mdiTag', 'mdiLink', 'mdiClipboardTextOutline', 'mdiPlus', 'mdiMenu',
    'mdiMagnify', 'mdiHome', 'mdiFolderOutline', 'mdiStar', 'mdiStarOutline', 'mdiCog',
    'mdiPencil', 'mdiTrashCanOutline', 'mdiClose', 'mdiCheck', 'mdiAlertOutline',
    'mdiHeartOutline', 'mdiThumbUpOutline', 'mdiCommentOutline', 'mdiShareVariantOutline',
    'mdiDownloadOutline', 'mdiUploadOutline', 'mdiRefresh', 'mdiLightbulbOutline',
  ],
  'Editor': [
    'mdiPencil', 'mdiPencilOutline', 'mdiSquareEditOutline', 'mdiFileDocumentEditOutline',
    'mdiFormatBold', 'mdiFormatItalic', 'mdiFormatUnderline', 'mdiFormatStrikethrough',
    'mdiFormatListBulleted', 'mdiFormatListNumbered', 'mdiFormatQuoteClose', 'mdiCodeTags',
    'mdiFormatColorText', 'mdiFormatColorFill', 'mdiFormatSize', 'mdiFormatAlignLeft',
    'mdiFormatAlignCenter', 'mdiFormatAlignRight', 'mdiFormatIndentIncrease', 'mdiFormatIndentDecrease',
  ],
  'Files': [
    'mdiFileOutline', 'mdiFile', 'mdiFileDocumentOutline', 'mdiFileDocument', 'mdiFolderOutline',
    'mdiFolder', 'mdiFolderOpenOutline', 'mdiFileMultiple', 'mdiFilePlus', 'mdiFileFind',
    'mdiFileDownload', 'mdiFileUpload', 'mdiFileExport', 'mdiFileImport', 'mdiFileCloud',
    'mdiFilePdfBox', 'mdiFileImageOutline', 'mdiFileVideoOutline', 'mdiFileMusicOutline',
  ],
  'Actions': [
    'mdiPlus', 'mdiMinus', 'mdiClose', 'mdiCheck', 'mdiCheckCircle', 'mdiCheckCircleOutline',
    'mdiCloseCircle', 'mdiCloseCircleOutline', 'mdiDelete', 'mdiDeleteOutline', 'mdiTrashCan',
    'mdiTrashCanOutline', 'mdiRefresh', 'mdiReload', 'mdiUndo', 'mdiRedo', 'mdiContentCopy',
    'mdiContentCut', 'mdiContentPaste', 'mdiContentSave', 'mdiContentSaveOutline',
  ],
  'Arrows': [
    'mdiArrowUp', 'mdiArrowDown', 'mdiArrowLeft', 'mdiArrowRight', 'mdiArrowUpBold',
    'mdiArrowDownBold', 'mdiArrowLeftBold', 'mdiArrowRightBold', 'mdiChevronUp',
    'mdiChevronDown', 'mdiChevronLeft', 'mdiChevronRight', 'mdiMenuUp', 'mdiMenuDown',
    'mdiMenuLeft', 'mdiMenuRight', 'mdiArrowExpand', 'mdiArrowCollapse',
  ],
  'UI': [
    'mdiMenu', 'mdiDotsVertical', 'mdiDotsHorizontal', 'mdiCog', 'mdiCogOutline',
    'mdiTune', 'mdiFilter', 'mdiFilterOutline', 'mdiSort', 'mdiSortVariant',
    'mdiViewGrid', 'mdiViewGridOutline', 'mdiViewList', 'mdiViewModule', 'mdiViewDashboard',
    'mdiFullscreen', 'mdiFullscreenExit', 'mdiWindowMaximize', 'mdiWindowMinimize',
  ],
  'Communication': [
    'mdiEmail', 'mdiEmailOutline', 'mdiMessage', 'mdiMessageOutline', 'mdiChat',
    'mdiChatOutline', 'mdiComment', 'mdiCommentOutline', 'mdiPhone', 'mdiPhoneOutline',
    'mdiBellOutline', 'mdiBell', 'mdiBellRing', 'mdiSend', 'mdiSendOutline',
  ],
  'Time': [
    'mdiCalendar', 'mdiCalendarOutline', 'mdiCalendarToday', 'mdiCalendarMonth',
    'mdiCalendarWeek', 'mdiClock', 'mdiClockOutline', 'mdiClockTimeEight',
    'mdiTimer', 'mdiTimerOutline', 'mdiAlarm', 'mdiHistory',
  ],
  'Media': [
    'mdiImage', 'mdiImageOutline', 'mdiCamera', 'mdiCameraOutline', 'mdiVideo',
    'mdiVideoOutline', 'mdiMusic', 'mdiMusicNote', 'mdiMusicNoteOutline', 'mdiPlayCircle',
    'mdiPauseCircle', 'mdiStopCircle', 'mdiVolumeHigh', 'mdiVolumeMute',
  ],
  'Social': [
    'mdiHeart', 'mdiHeartOutline', 'mdiStar', 'mdiStarOutline', 'mdiThumbUp',
    'mdiThumbUpOutline', 'mdiThumbDown', 'mdiThumbDownOutline', 'mdiShare',
    'mdiShareVariant', 'mdiShareOutline', 'mdiAccountOutline', 'mdiAccountCircle',
  ],
  'Navigation': [
    'mdiHome', 'mdiHomeOutline', 'mdiMagnify', 'mdiEarth', 'mdiMapMarker',
    'mdiMapMarkerOutline', 'mdiCompass', 'mdiCompassOutline', 'mdiNavigation',
  ],
  'Objects': [
    'mdiLightbulb', 'mdiLightbulbOutline', 'mdiBook', 'mdiBookOutline', 'mdiBookOpenPageVariant',
    'mdiNotebook', 'mdiNotebookOutline', 'mdiPaperclip', 'mdiPin', 'mdiPinOutline',
    'mdiFlag', 'mdiFlagOutline', 'mdiBookmark', 'mdiBookmarkOutline', 'mdiTag',
    'mdiTagOutline', 'mdiGift', 'mdiGiftOutline', 'mdiTrophy', 'mdiTrophyOutline',
  ],
  'Tech': [
    'mdiLaptop', 'mdiMonitor', 'mdiCellphone', 'mdiTablet', 'mdiKeyboard',
    'mdiMouse', 'mdiPrinter', 'mdiServer', 'mdiDatabase', 'mdiDatabaseOutline',
    'mdiCloud', 'mdiCloudOutline', 'mdiWifi', 'mdiBluetooth', 'mdiUsb',
  ],
  'Security': [
    'mdiLock', 'mdiLockOutline', 'mdiLockOpen', 'mdiLockOpenOutline', 'mdiKey',
    'mdiKeyOutline', 'mdiShield', 'mdiShieldOutline', 'mdiEye', 'mdiEyeOutline',
    'mdiEyeOff', 'mdiEyeOffOutline', 'mdiFingerprint', 'mdiSecurity',
  ],
  'Weather': [
    'mdiWeatherSunny', 'mdiWeatherNight', 'mdiWeatherCloudy', 'mdiWeatherPartlyCloudy',
    'mdiWeatherRainy', 'mdiWeatherSnowy', 'mdiWeatherLightning', 'mdiWeatherFog',
  ],
};

type TabType = 'emojis' | 'symbols';

interface EmojiPickerProps {
  /** Currently selected value (emoji or icon name) */
  value?: string;
  /** Called when a selection is made */
  onSelect: (value: string) => void;
  /** Called when picker should close */
  onClose: () => void;
  /** Position of the picker */
  position?: { x: number; y: number };
  /** Whether to show as a popup (positioned) or inline */
  asPopup?: boolean;
}

export function EmojiPicker({
  value,
  onSelect,
  onClose,
  position,
  asPopup = true,
}: EmojiPickerProps) {
  const [activeTab, setActiveTab] = useState<TabType>('emojis');
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>(Object.keys(EMOJI_CATEGORIES)[0]);
  const [selectedMdiCategory, setSelectedMdiCategory] = useState<string>('Popular');
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  
  // Focus search on mount
  useEffect(() => {
    searchRef.current?.focus();
  }, []);
  
  // Close on click outside
  useEffect(() => {
    if (!asPopup) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [asPopup, onClose]);
  
  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);
  
  // Filter emojis based on search (by name or character)
  const filteredEmojis = useMemo(() => {
    if (!search) {
      return EMOJI_CATEGORIES[selectedCategory as keyof typeof EMOJI_CATEGORIES] || [];
    }
    
    const searchLower = search.toLowerCase();
    const results: string[] = [];
    
    // Search across all categories
    for (const emojis of Object.values(EMOJI_CATEGORIES)) {
      for (const emoji of emojis) {
        // Search by emoji character or by name
        if (emoji.includes(search)) {
          results.push(emoji);
        } else if (EMOJI_NAMES[emoji]) {
          const names = EMOJI_NAMES[emoji];
          if (names.some(name => name.includes(searchLower))) {
            results.push(emoji);
          }
        }
      }
    }
    
    // Remove duplicates
    return Array.from(new Set(results));
  }, [search, selectedCategory]);
  
  // Get all MDI icon names
  const allMdiIcons = useMemo(() => {
    return Object.keys(mdiIcons)
      .filter(key => key.startsWith('mdi') && key !== 'default')
      .sort();
  }, []);
  
  // Filter MDI icons based on search and category
  const filteredMdiIcons = useMemo(() => {
    if (search) {
      // When searching, search all icons (no limit)
      const searchLower = search.toLowerCase();
      return allMdiIcons.filter(name => 
        name.toLowerCase().includes(searchLower)
      );
    }
    
    // When not searching, show selected category
    return MDI_CATEGORIES[selectedMdiCategory] || MDI_CATEGORIES['Popular'];
  }, [search, selectedMdiCategory, allMdiIcons]);
  
  // Handle emoji selection
  const handleEmojiSelect = useCallback((emoji: string) => {
    onSelect(emoji);
    onClose();
  }, [onSelect, onClose]);
  
  // Handle MDI icon selection
  const handleMdiSelect = useCallback((iconName: string) => {
    // Convert camelCase to kebab-case: mdiCalendarToday -> mdi-calendar-today
    const kebabName = iconName
      .replace(/^mdi/, 'mdi-')
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .toLowerCase();
    onSelect(kebabName);
    onClose();
  }, [onSelect, onClose]);
  
  // Handle remove icon
  const handleRemove = useCallback(() => {
    onSelect('');
    onClose();
  }, [onSelect, onClose]);
  
  // Get MDI path for preview
  const getMdiPath = (iconName: string): string | null => {
    const path = (mdiIcons as Record<string, string>)[iconName];
    return path || null;
  };
  
  const style: React.CSSProperties = asPopup && position
    ? {
        position: 'fixed',
        left: position.x,
        top: position.y,
      }
    : {};
  
  return (
    <div 
      className={`emoji-picker ${asPopup ? 'popup' : 'inline'}`} 
      ref={pickerRef}
      style={style}
    >
      {/* Tabs */}
      <div className="emoji-picker-tabs">
        <Button
          variant="ghost"
          size="sm"
          active={activeTab === 'emojis'}
          onClick={() => setActiveTab('emojis')}
          className="emoji-picker-tab"
        >
          😀 Emojis
        </Button>
        <Button
          icon={mdiShapeOutline}
          variant="ghost"
          size="sm"
          active={activeTab === 'symbols'}
          onClick={() => setActiveTab('symbols')}
          className="emoji-picker-tab"
        >
          Symbols
        </Button>
      </div>
      
      {/* Search */}
      <div className="emoji-picker-search">
        <input
          ref={searchRef}
          type="text"
          className="emoji-picker-search-input"
          placeholder={activeTab === 'emojis' ? 'Search emojis...' : 'Search icons...'}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      
      {/* Content based on active tab */}
      {activeTab === 'emojis' ? (
        <div className="emoji-picker-content">
          {/* Category selector (only when not searching) */}
          {!search && (
            <div className="emoji-picker-categories">
              {Object.keys(EMOJI_CATEGORIES).map(category => (
                <button
                  key={category}
                  className={`emoji-picker-category ${selectedCategory === category ? 'active' : ''}`}
                  onClick={() => setSelectedCategory(category)}
                  title={category}
                >
                  {EMOJI_CATEGORIES[category as keyof typeof EMOJI_CATEGORIES][0]}
                </button>
              ))}
            </div>
          )}
          
          {/* Emoji grid */}
          <div className="emoji-picker-grid">
            {filteredEmojis.map((emoji, index) => (
              <button
                key={`${emoji}-${index}`}
                className={`emoji-picker-item ${value === emoji ? 'selected' : ''}`}
                onClick={() => handleEmojiSelect(emoji)}
                title={emoji}
              >
                {emoji}
              </button>
            ))}
            {filteredEmojis.length === 0 && (
              <div className="emoji-picker-empty">No emojis found</div>
            )}
          </div>
        </div>
      ) : (
        <div className="emoji-picker-content">
          {/* MDI Category selector (only when not searching) */}
          {!search && (
            <div className="emoji-picker-mdi-categories">
              {Object.keys(MDI_CATEGORIES).map(category => (
                <button
                  key={category}
                  className={`emoji-picker-mdi-category ${selectedMdiCategory === category ? 'active' : ''}`}
                  onClick={() => setSelectedMdiCategory(category)}
                >
                  {category}
                </button>
              ))}
            </div>
          )}
          
          {/* MDI icon grid */}
          <div className="emoji-picker-grid mdi-grid">
            {filteredMdiIcons.map(iconName => {
              const path = getMdiPath(iconName);
              if (!path) return null;
              
              // Convert to kebab for comparison with value
              const kebabName = iconName
                .replace(/^mdi/, 'mdi-')
                .replace(/([a-z])([A-Z])/g, '$1-$2')
                .toLowerCase();
              
              return (
                <button
                  key={iconName}
                  className={`emoji-picker-item mdi-item ${value === kebabName ? 'selected' : ''}`}
                  onClick={() => handleMdiSelect(iconName)}
                  title={kebabName}
                >
                  <Icon path={path} size={0.9} />
                </button>
              );
            })}
            {filteredMdiIcons.length === 0 && (
              <div className="emoji-picker-empty">No icons found</div>
            )}
          </div>
          {!search && (
            <div className="emoji-picker-hint">
              {filteredMdiIcons.length} icons in {selectedMdiCategory}. Search to find from all {allMdiIcons.length}+ icons.
            </div>
          )}
          {search && filteredMdiIcons.length > 0 && (
            <div className="emoji-picker-hint">
              Found {filteredMdiIcons.length} icons
            </div>
          )}
        </div>
      )}
      
      {/* Footer with remove option */}
      {value && (
        <div className="emoji-picker-footer">
          <Button 
            variant="danger" 
            size="sm" 
            onClick={handleRemove}
            className="emoji-picker-remove"
          >
            Remove icon
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * EmojiPickerTrigger - A button that opens the emoji picker
 */
interface EmojiPickerTriggerProps {
  /** Currently selected value */
  value?: string;
  /** Called when a selection is made */
  onSelect: (value: string) => void;
  /** Placeholder text when no value */
  placeholder?: string;
  /** Additional class name */
  className?: string;
}

export function EmojiPickerTrigger({
  value,
  onSelect,
  placeholder = 'Add icon',
  className = '',
}: EmojiPickerTriggerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  
  const handleClick = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPosition({
        x: Math.min(rect.left, window.innerWidth - 320),
        y: Math.min(rect.bottom + 4, window.innerHeight - 400),
      });
    }
    setIsOpen(true);
  }, []);
  
  const handleSelect = useCallback((selectedValue: string) => {
    onSelect(selectedValue);
    setIsOpen(false);
  }, [onSelect]);
  
  // Render icon preview
  const renderValue = () => {
    if (!value) {
      return <span className="emoji-trigger-placeholder">{placeholder}</span>;
    }
    
    // Check if it's an MDI icon (starts with mdi-)
    if (value.startsWith('mdi-')) {
      // Convert kebab-case to camelCase
      const camelName = value
        .replace(/^mdi-/, 'mdi')
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      
      const path = (mdiIcons as Record<string, string>)[camelName];
      if (path) {
        return <Icon path={path} size={0.9} />;
      }
    }
    
    // It's an emoji
    return <span className="emoji-trigger-emoji">{value}</span>;
  };
  
  return (
    <>
      <button
        ref={triggerRef}
        className={`emoji-picker-trigger ${className} ${value ? 'has-value' : ''}`}
        onClick={handleClick}
        type="button"
      >
        {renderValue()}
      </button>
      
      {isOpen && (
        <EmojiPicker
          value={value}
          onSelect={handleSelect}
          onClose={() => setIsOpen(false)}
          position={position}
        />
      )}
    </>
  );
}

export default EmojiPicker;
