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

// Common/popular MDI icons for quick access
const POPULAR_MDI_ICONS = [
  'mdiFileDocumentOutline', 'mdiCalendarToday', 'mdiBookOpenPageVariant', 'mdiNotebookOutline',
  'mdiGraphOutline', 'mdiTag', 'mdiLink', 'mdiClipboardTextOutline', 'mdiPlus', 'mdiMenu',
  'mdiMagnify', 'mdiHome', 'mdiFolderOutline', 'mdiStar', 'mdiStarOutline', 'mdiCog',
  'mdiPencil', 'mdiTrashCanOutline', 'mdiClose', 'mdiCheck', 'mdiAlertOutline',
  'mdiImageOutline', 'mdiPaperclip', 'mdiMusicNoteOutline', 'mdiDatabaseOutline',
  'mdiAccountOutline', 'mdiEmailOutline', 'mdiPhoneOutline', 'mdiMapMarkerOutline',
  'mdiClockOutline', 'mdiCalendarMonthOutline', 'mdiHeartOutline', 'mdiThumbUpOutline',
  'mdiCommentOutline', 'mdiShareVariantOutline', 'mdiDownloadOutline', 'mdiUploadOutline',
  'mdiRefresh', 'mdiSyncOutline', 'mdiCloudOutline', 'mdiLockOutline', 'mdiLockOpenOutline',
  'mdiEyeOutline', 'mdiEyeOffOutline', 'mdiFilterOutline', 'mdiSortVariant',
  'mdiFormatListBulletedSquare', 'mdiViewGridOutline', 'mdiTableOutline', 'mdiChartLineVariant',
  'mdiCodeTags', 'mdiGitOutline', 'mdiLightbulbOutline', 'mdiBookmarkOutline',
  'mdiFlagOutline', 'mdiBellOutline', 'mdiCameraOutline', 'mdiVideoOutline',
  'mdiMicrophoneOutline', 'mdiPrinterOutline', 'mdiWifiOutline', 'mdiBluetoothOutline',
  'mdiBatteryOutline', 'mdiWeatherSunny', 'mdiWeatherNight', 'mdiWeatherCloudy',
  'mdiCurrencyUsd', 'mdiCartOutline', 'mdiCreditCardOutline', 'mdiGiftOutline',
  'mdiTrophyOutline', 'mdiMedalOutline', 'mdiSchoolOutline', 'mdiBriefcaseOutline',
  'mdiHammerWrench', 'mdiWrenchOutline', 'mdiPaletteOutline', 'mdiFormatPaintOutline',
  'mdiRocketLaunchOutline', 'mdiAirplane', 'mdiCarOutline', 'mdiTrainVariant',
  'mdiRunFast', 'mdiWeightLifter', 'mdiYoga', 'mdiMeditation',
  'mdiCoffee', 'mdiFoodAppleOutline', 'mdiGlassCocktail', 'mdiPizzaOutline',
];

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
  
  // Filter emojis based on search
  const filteredEmojis = useMemo(() => {
    if (!search) {
      return EMOJI_CATEGORIES[selectedCategory as keyof typeof EMOJI_CATEGORIES] || [];
    }
    
    // Search across all categories
    const results: string[] = [];
    for (const emojis of Object.values(EMOJI_CATEGORIES)) {
      results.push(...emojis.filter(emoji => emoji.includes(search)));
    }
    return results;
  }, [search, selectedCategory]);
  
  // Get all MDI icon names
  const allMdiIcons = useMemo(() => {
    return Object.keys(mdiIcons)
      .filter(key => key.startsWith('mdi') && key !== 'default')
      .sort();
  }, []);
  
  // Filter MDI icons based on search
  const filteredMdiIcons = useMemo(() => {
    const icons = search ? allMdiIcons : POPULAR_MDI_ICONS;
    if (!search) return icons;
    
    const searchLower = search.toLowerCase();
    return allMdiIcons.filter(name => 
      name.toLowerCase().includes(searchLower)
    ).slice(0, 200); // Limit results for performance
  }, [search, allMdiIcons]);
  
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
              Showing popular icons. Search to find more.
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
