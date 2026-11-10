// A screen that fails to load, or throws while it draws: "This screen didn’t
// load · Reload" in its place — never a blank page. The nav stays, so every
// other screen is a tap away; going to one clears it. (A screen whose file
// is gone after a deploy has already tried the new page once by itself —
// main.jsx; while that reload is on its way this says "Loading…".)
import { Component } from 'react';
import { useLocation } from 'react-router-dom';
import { reloading } from '../build.js';
import './reload.css';

class Boundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(prev) {
    if (this.state.failed && prev.at !== this.props.at) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (reloading()) return <p className="muted">Loading…</p>;
    return (
      <div className="card screen-failed" role="alert">
        <p className="screen-failed__text">This screen didn’t load</p>
        <button type="button" className="btn btn-primary screen-failed__btn" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}

export default function ScreenBoundary({ children }) {
  const { pathname } = useLocation();
  return <Boundary at={pathname}>{children}</Boundary>;
}
