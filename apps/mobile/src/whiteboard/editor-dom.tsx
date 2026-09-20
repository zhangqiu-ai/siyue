'use dom';
import './web-policy';
import Editor, { type EditorProps } from '@siyue/whiteboard/editor';
export default function WhiteboardDOM(props: EditorProps & { dom?: import('expo/dom').DOMProps }) {
  return <Editor {...props}/>;
}
