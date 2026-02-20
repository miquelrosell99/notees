/**
 * EmojiPicker Component
 *
 * A picker with three tabs: All, Emojis, Icons (MDI symbols).
 * - All: Recently used items + typical emojis + typical icons
 * - Emojis: Full emoji list, lazy-loaded per category
 * - Icons: Full MDI icon list, lazy-loaded per category
 *
 * Returns the emoji character or MDI icon name (e.g. "mdi-calendar")
 */
import {
  useState,
  useMemo,
  useRef,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';
import Icon from '@mdi/react';
import * as mdiIcons from '@mdi/js';
import { mdiTrashCanOutline } from '@mdi/js';
import { getMdiPath } from '@/utils/iconDom';

import { Button } from './Button';
import { ColorButton } from './ColorButton';
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

// ─────────────────────────────────────────────
// Typical items shown in "All" tab
// ─────────────────────────────────────────────

const TYPICAL_EMOJIS = EMOJI_CATEGORIES['Smileys'].slice(0, 32);
const TYPICAL_ICONS = MDI_CATEGORIES['Popular'].slice(0, 24);

// ─────────────────────────────────────────────
// Recents (localStorage)
// ─────────────────────────────────────────────

const RECENTS_KEY = 'emoji-picker-recents';
const MAX_RECENTS = 20;

function getRecents(): string[] {
  try {
    const stored = localStorage.getItem(RECENTS_KEY);
    return stored ? (JSON.parse(stored) as string[]) : [];
  } catch {
    return [];
  }
}

function addRecent(value: string): void {
  try {
    const recents = getRecents().filter((r) => r !== value);
    recents.unshift(value);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents.slice(0, MAX_RECENTS)));
  } catch {
    // ignore
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function iconCamelToKebab(name: string): string {
  return name
    .replace(/^mdi/, 'mdi-')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

function getIconPath(name: string): string | null {
  return (mdiIcons as Record<string, string>)[name] ?? null;
}

// ─────────────────────────────────────────────
// LazyCategory – renders a section only when scrolled into view
// ─────────────────────────────────────────────

interface LazyCategoryProps {
  label: string;
  items: string[];
  isIcon: boolean;
  selectedValue?: string;
  onSelect: (item: string) => void;
}

function LazyCategory({ label, items, isIcon, selectedValue, onSelect }: LazyCategoryProps) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '400px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rowSize = isIcon ? 34 : 36;
  const cols = 8;
  const placeholderHeight = Math.ceil(items.length / cols) * rowSize + 28;

  return (
    <div ref={ref} className="ep-category-section">
      <div className="ep-category-label">{label}</div>
      {visible ? (
        <div className={`ep-grid ${isIcon ? 'ep-icon-grid' : 'ep-emoji-grid'}`}>
          {items.map((item, idx) => {
            if (isIcon) {
              const path = getIconPath(item);
              if (!path) return null;
              const kebab = iconCamelToKebab(item);
              return (
                <Button
                  key={item}
                  variant="ghost"
                  size="xs"
                  title={kebab}
                  active={selectedValue === kebab}
                  className="ep-item"
                  onClick={() => onSelect(item)}
                >
                  <Icon path={path} size={0.85} />
                </Button>
              );
            }
            return (
              <Button
                key={`${item}-${idx}`}
                variant="ghost"
                size="xs"
                title={item}
                active={selectedValue === item}
                className="ep-item ep-emoji-item"
                onClick={() => onSelect(item)}
              >
                {item}
              </Button>
            );
          })}
        </div>
      ) : (
        <div style={{ height: placeholderHeight }} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// ItemGrid – simple non-lazy grid
// ─────────────────────────────────────────────

interface ItemGridProps {
  items: string[];
  isIcon: boolean;
  selectedValue?: string;
  onSelect: (item: string) => void;
}

function ItemGrid({ items, isIcon, selectedValue, onSelect }: ItemGridProps) {
  if (items.length === 0) return null;
  return (
    <div className={`ep-grid ${isIcon ? 'ep-icon-grid' : 'ep-emoji-grid'}`}>
      {items.map((item, idx) => {
        if (isIcon) {
          const path = getIconPath(item);
          if (!path) return null;
          const kebab = iconCamelToKebab(item);
          return (
            <Button
              key={item}
              variant="ghost"
              size="xs"
              title={kebab}
              active={selectedValue === kebab}
              className="ep-item"
              onClick={() => onSelect(item)}
            >
              <Icon path={path} size={0.85} />
            </Button>
          );
        }
        return (
          <Button
            key={`${item}-${idx}`}
            variant="ghost"
            size="xs"
            title={item}
            active={selectedValue === item}
            className="ep-item ep-emoji-item"
            onClick={() => onSelect(item)}
          >
            {item}
          </Button>
        );
      })}
    </div>
  );
}

function SectionHeader({ children }: { children: ReactNode }) {
  return <div className="ep-section-header">{children}</div>;
}

// ─────────────────────────────────────────────
// Main EmojiPicker
// ─────────────────────────────────────────────

type TabType = 'all' | 'emojis' | 'icons';



export interface EmojiPickerProps {
  /** Currently selected value (emoji character or "mdi-name") */
  value?: string;
  /** Called when a selection is made */
  onSelect: (value: string) => void;
  /** Called when picker should close */
  onClose: () => void;
  /** Position for popup mode */
  position?: { x: number; y: number };
  /** Show as fixed popup (true) or inline block (false) */
  asPopup?: boolean;
  /** Show a colour button in the header */
  useColor?: boolean;
  /** Currently selected colour */
  color?: string | null;
  /** Called when a colour is chosen */
  onColorChange?: (color: string | null) => void;
}

export function EmojiPicker({
  value,
  onSelect,
  onClose,
  position,
  asPopup = true,
  useColor = false,
  color,
  onColorChange,
}: EmojiPickerProps) {
  const [activeTab, setActiveTab] = useState<TabType>('all');
  const [search, setSearch] = useState('');
  const [recents, setRecents] = useState<string[]>(() => getRecents());

  const pickerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  useEffect(() => {
    if (!asPopup) return;
    const handle = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [asPopup, onClose]);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

  const allMdiNames = useMemo(
    () => Object.keys(mdiIcons).filter((k) => k.startsWith('mdi') && k !== 'default').sort(),
    [],
  );

  const searchResults = useMemo(() => {
    if (!search) return null;
    const q = search.toLowerCase();
    const emojis: string[] = [];
    for (const list of Object.values(EMOJI_CATEGORIES)) {
      for (const e of list) { if (e.toLowerCase().includes(q)) emojis.push(e); }
    }
    const icons = allMdiNames.filter((n) => n.toLowerCase().includes(q));
    return { emojis: Array.from(new Set(emojis)), icons };
  }, [search, allMdiNames]);

  const handleSelect = useCallback(
    (raw: string, isIcon: boolean) => {
      const final = isIcon ? iconCamelToKebab(raw) : raw;
      addRecent(final);
      setRecents(getRecents());
      onSelect(final);
      onClose();
    },
    [onSelect, onClose],
  );

  const handleRemove = useCallback(() => { onSelect(''); onClose(); }, [onSelect, onClose]);

  function isIconValue(val: string) {
    return val.startsWith('mdi-') || val.startsWith('mdi:') || val.startsWith('mdi_');
  }

  function kebabToCamel(kebab: string): string {
    const withoutPrefix = kebab.replace(/^mdi-/, '');
    return 'mdi' + withoutPrefix.replace(/(^|-)([a-z])/g, (_, _sep, c: string) => c.toUpperCase());
  }

  const popupStyle: React.CSSProperties =
    asPopup && position ? { position: 'fixed', left: position.x, top: position.y } : {};

  const handleTabChange = (tab: TabType) => {
    setActiveTab(tab);
    setSearch('');
    contentRef.current?.scrollTo({ top: 0 });
  };

  return (
    <div
      ref={pickerRef}
      className={`ep ${asPopup ? 'ep--popup' : 'ep--inline'}`}
      style={popupStyle}
    >
      {/* Header: tabs + actions */}
      <div className="ep-header">
        <div className="ep-tabs">
          <Button variant="ghost" size="sm" active={activeTab === 'all'} onClick={() => handleTabChange('all')}>All</Button>
          <Button variant="ghost" size="sm" active={activeTab === 'emojis'} onClick={() => handleTabChange('emojis')}>Emojis</Button>
          <Button variant="ghost" size="sm" active={activeTab === 'icons'} onClick={() => handleTabChange('icons')}>Icons</Button>
        </div>
        <div className="ep-header-actions">
          {useColor && onColorChange && (
            <ColorButton
              color={color ?? ''}
              size="sm"
              showPicker
              showNoneOption
              onColorChange={onColorChange}
            />
          )}
          <Button variant="ghost" size="sm" icon={mdiTrashCanOutline} iconOnly title="Remove icon" onClick={handleRemove} />
        </div>
      </div>


      {/* Search */}
      <div className="ep-search">
        <input
          ref={searchRef}
          type="text"
          className="ep-search-input"
          placeholder="Search&#8230;"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Content */}
      <div ref={contentRef} className="ep-content">
        {/* Search results */}
        {searchResults && (
          <>
            {searchResults.emojis.length > 0 && (
              <div className="ep-category-section">
                <SectionHeader>Emojis</SectionHeader>
                <ItemGrid items={searchResults.emojis} isIcon={false} selectedValue={value} onSelect={(e) => handleSelect(e, false)} />
              </div>
            )}
            {searchResults.icons.length > 0 && (
              <div className="ep-category-section">
                <SectionHeader>Icons</SectionHeader>
                <ItemGrid items={searchResults.icons} isIcon selectedValue={value} onSelect={(e) => handleSelect(e, true)} />
              </div>
            )}
            {searchResults.emojis.length === 0 && searchResults.icons.length === 0 && (
              <div className="ep-empty">No results for &#8220;{search}&#8221;</div>
            )}
          </>
        )}

        {/* All tab */}
        {!searchResults && activeTab === 'all' && (
          <>
            {recents.length > 0 && (
              <div className="ep-category-section">
                <SectionHeader>Recents</SectionHeader>
                <div className="ep-grid ep-mixed-grid">
                  {recents.map((item) => {
                    if (isIconValue(item)) {
                      const camel = kebabToCamel(item);
                      const path = getIconPath(camel);
                      if (!path) return null;
                      return (
                        <Button key={item} variant="ghost" size="xs" title={item} active={value === item} className="ep-item"
                          onClick={() => { addRecent(item); setRecents(getRecents()); onSelect(item); onClose(); }}>
                          <Icon path={path} size={0.85} />
                        </Button>
                      );
                    }
                    return (
                      <Button key={item} variant="ghost" size="xs" title={item} active={value === item} className="ep-item ep-emoji-item"
                        onClick={() => { addRecent(item); setRecents(getRecents()); onSelect(item); onClose(); }}>
                        {item}
                      </Button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="ep-category-section">
              <SectionHeader>Emojis</SectionHeader>
              <ItemGrid items={TYPICAL_EMOJIS} isIcon={false} selectedValue={value} onSelect={(e) => handleSelect(e, false)} />
            </div>
            <div className="ep-category-section">
              <SectionHeader>Icons</SectionHeader>
              <ItemGrid items={TYPICAL_ICONS} isIcon selectedValue={value} onSelect={(e) => handleSelect(e, true)} />
            </div>
          </>
        )}

        {/* Emojis tab */}
        {!searchResults && activeTab === 'emojis' &&
          Object.entries(EMOJI_CATEGORIES).map(([cat, items]) => (
            <LazyCategory key={cat} label={cat} items={items} isIcon={false} selectedValue={value} onSelect={(e) => handleSelect(e, false)} />
          ))
        }

        {/* Icons tab */}
        {!searchResults && activeTab === 'icons' &&
          Object.entries(MDI_CATEGORIES).map(([cat, items]) => (
            <LazyCategory key={cat} label={cat} items={items} isIcon selectedValue={value} onSelect={(e) => handleSelect(e, true)} />
          ))
        }
      </div>
    </div>
  );
}

// 
// EmojiPickerTrigger
// 

interface EmojiPickerTriggerProps {
  value?: string;
  onSelect: (value: string) => void;
  placeholder?: string;
  className?: string;
  useColor?: boolean;
  color?: string | null;
  onColorChange?: (color: string | null) => void;
}

export function EmojiPickerTrigger({
  value,
  onSelect,
  placeholder = 'Add icon',
  className = '',
  useColor = false,
  color,
  onColorChange,
}: EmojiPickerTriggerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);

  const handleClick = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPosition({
        x: Math.min(rect.left, window.innerWidth - 340),
        y: Math.min(rect.bottom + 4, window.innerHeight - 450),
      });
    }
    setIsOpen(true);
  }, []);

  const handleSelect = useCallback(
    (selected: string) => { onSelect(selected); setIsOpen(false); },
    [onSelect],
  );

  const renderValue = () => {
    if (!value) return <span className="ep-trigger-placeholder">{placeholder}</span>;
    const mdiPath = getMdiPath(value);
    if (mdiPath) return <Icon path={mdiPath} size={0.9} color={color ?? undefined} />;
    return <span className="ep-trigger-emoji" style={color ? { color } : undefined}>{value}</span>;
  };

  return (
    <>
      <button
        ref={triggerRef}
        className={`ep-trigger ${className} ${value ? 'ep-trigger--has-value' : ''}`}
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
          useColor={useColor}
          color={color}
          onColorChange={onColorChange}
        />
      )}
    </>
  );
}

export default EmojiPicker;
