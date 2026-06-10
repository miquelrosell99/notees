/**
 * EmojiPicker Component
 *
 * A picker with three tabs: All, Emojis, Icons (MDI symbols).
 * - All: Recently used items + typical emojis + typical icons
 * - Emojis: Full emoji list, lazy-loaded per category
 * - Icons: Full MDI icon list, lazy-loaded per category
 *
 * Returns the emoji character or MDI icon name (e.g. "mdiCalendar")
 */
import React, {
  useState,
  useMemo,
  useRef,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';

import { MDI_ICON_LIST } from '@/utils/mdiIconList';
import { getMdiClass } from '@/utils/iconDom';

import { Button } from './Button';
import { ColorButton } from './ColorButton';
import './EmojiPicker.css';
import { Icon } from '@/components/ui/icons';

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

function getIconClass(name: string): string | null {
  return getMdiClass(name);
}

function iconCamelToKebab(name: string): string {
  return name.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`).replace(/^-/, '');
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
      { rootMargin: '100px' },
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
              const path = getIconClass(item);
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

const ItemGrid = React.memo(function ItemGrid({ items, isIcon, selectedValue, onSelect }: ItemGridProps) {
  if (items.length === 0) return null;
  return (
    <div className={`ep-grid ${isIcon ? 'ep-icon-grid' : 'ep-emoji-grid'}`}>
      {items.map((item, idx) => {
        if (isIcon) {
          const path = getIconClass(item);
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
});

function SectionHeader({ children }: { children: ReactNode }) {
  return <div className="ep-section-header">{children}</div>;
}

// ─────────────────────────────────────────────
// Main EmojiPicker
// ─────────────────────────────────────────────

type TabType = 'all' | 'emojis' | 'icons';

export interface EmojiPickerProps {
  /** Currently selected value (emoji character or camelCase MDI key e.g. "mdiCalendar") */
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
    () => MDI_ICON_LIST.filter((k) => k.startsWith('mdi')).sort(),
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
    const MAX_RESULTS = 100;
    return {
      emojis: Array.from(new Set(emojis)).slice(0, MAX_RESULTS),
      icons: icons.slice(0, MAX_RESULTS),
      hasMoreEmojis: emojis.length > MAX_RESULTS,
      hasMoreIcons: icons.length > MAX_RESULTS,
    };
  }, [search, allMdiNames]);

  const handleSelect = useCallback(
    (raw: string, _isIcon: boolean) => {
      addRecent(raw);
      setRecents(getRecents());
      onSelect(raw);
      onClose();
    },
    [onSelect, onClose],
  );

  const handleRemove = useCallback(() => { onSelect(''); onClose(); }, [onSelect, onClose]);

  function isIconValue(val: string) {
    return /^mdi[A-Z]/.test(val);
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
          <Button variant="ghost" size="sm" icon={"mdi mdi-trash-can-outline"} title="Remove icon" onClick={handleRemove} />
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
            {searchResults.hasMoreEmojis && (
              <div className="ep-more-hint">100+ emojis match — type a more specific query</div>
            )}
            {searchResults.hasMoreIcons && (
              <div className="ep-more-hint">100+ icons match — type a more specific query</div>
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
                      const path = getMdiClass(item);
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
    const mdiPath = getMdiClass(value);
    if (mdiPath) return <Icon path={mdiPath} size={0.9} color={color ?? undefined} />;
    // Don't render raw MDI icon names as text — show nothing instead
    if (value.match(/^mdi[A-Z]/)) return null;
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

