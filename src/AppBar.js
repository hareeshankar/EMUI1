import React from "react";
import PropTypes from "prop-types";
import { withStyles } from "@material-ui/core/styles";
import AppBar from "@material-ui/core/AppBar";
import Toolbar from "@material-ui/core/Toolbar";
import Typography from "@material-ui/core/Typography";
import { MuiThemeProvider, createMuiTheme } from "@material-ui/core/styles";
import blue from "@material-ui/core/colors/blue";

const styles = {
  root: {
    flexGrow: 1
  }
};
const theme = createMuiTheme({
  palette: {
    primary: blue
  }
});
function SimpleAppBar(props) {
  const { classes } = props;

  return (
    <div className={classes.root}>
      <MuiThemeProvider theme={theme}>
        <AppBar position="static" className="typo">
          <Typography className="typo" variant="h4" color="inherit">
            <span className="appbar">Event Manager</span>
          </Typography>
        </AppBar>
      </MuiThemeProvider>
    </div>
  );
}

SimpleAppBar.propTypes = {
  classes: PropTypes.object.isRequired
};

export default withStyles(styles)(SimpleAppBar);
